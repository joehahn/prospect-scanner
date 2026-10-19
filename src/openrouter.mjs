// Every non-Claude model call, through OpenRouter. Called only by complete() in
// models.mjs, which records each call; nothing here writes to the database.
//
// THE RIGHT-SIZING STUDY NEEDS MODELS ANTHROPIC DOES NOT SELL (TODO.md F3), and
// OpenRouter serves most of them behind one key and one request shape. The
// shape is OpenAI's chat completions, so complete()'s Anthropic-style request
// is translated here and the answer translated back, and a stage cannot tell
// which path ran except by the model id it was given.
//
// THE PROSPECT'S DATA DOES NOT GO WHERE IT CAN BE KEPT. A judge or drafter
// prompt carries names, pasted profiles and the operator's config. Every
// request asks for zero-data-retention endpoints that do not collect data,
// whatever the account settings say, and a model with no such endpoint fails
// rather than being routed somewhere looser.
//
// Borrowed, and credited where they came from (TODO.md F3): the strict schema
// with require_parameters, the empty-answer-is-a-failure rule, one retry layer
// by status, parameter step-down, and JSON repair.

const URL_ = 'https://openrouter.ai/api/v1/chat/completions';

// What each model takes beyond the basics. A parameter a model does not
// support, sent with require_parameters, leaves NO eligible provider: the call
// "finishes" with nothing (geo-herd-rider, llm.py). So nothing optional is sent
// unless the model is listed here, and an unlisted model gets the bare request.
// Filled from OpenRouter's /models `supported_parameters` at the smoke test.
const CAPABILITIES = {};
const capsFor = (model) => CAPABILITIES[model] ?? { reasoning: false };

// USD per 1M tokens, used only when a response carries no billed cost. The
// billed `usage.cost` is the record; this keeps a missing one from reading $0.
const PRICING = {};

export function knownOpenRouterModels() { return Object.keys(PRICING); }
export const isOpenRouter = (model) => !String(model).startsWith('claude-');

// Swappable for tests, so retries neither hit the network nor wait.
export const deps = {
  fetch: (...a) => globalThis.fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  key: () => process.env.OPENROUTER_API_KEY,
};

const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const ATTEMPTS = 3;
const TIMEOUT_MS = 4 * 60_000;
const RETRY_AFTER_CAP_MS = 60_000;

class OpenRouterError extends Error {
  constructor(message, { status = null, transient = false } = {}) {
    super(message); this.status = status; this.transient = transient;
  }
}

// complete()'s messages carry Anthropic content blocks. Text is all any stage
// sends; anything else fails here rather than being silently dropped.
function textOf(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).map((b) => {
    if (b.type === 'text') return b.text;
    throw new Error(`OpenRouter path cannot send a "${b.type}" content block`);
  }).join('\n');
}

function buildBody({ model, system, messages, maxTokens, effort, thinking, schema }) {
  const caps = capsFor(model);
  const sys = (Array.isArray(system) ? system : [system]).filter(Boolean).join('');
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [
      ...(sys ? [{ role: 'system', content: sys }] : []),
      ...messages.map((m) => ({ role: m.role, content: textOf(m.content) })),
    ],
    provider: { require_parameters: true, data_collection: 'deny', zdr: true },
    usage: { include: true },
  };
  if (thinking && caps.reasoning) body.reasoning = { effort: effort === 'max' ? 'high' : effort };
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } };
  return body;
}

async function post(body) {
  const key = deps.key();
  if (!key) throw new OpenRouterError('No OPENROUTER_API_KEY in .env. Nothing was sent and nothing was recorded.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await deps.fetch(URL_, {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new OpenRouterError(`OpenRouter unreachable: ${e.message}`, { transient: true });
  } finally { clearTimeout(timer); }
  let json = null;
  try { json = await res.json(); } catch { /* a malformed body is transient */ }
  if (!res.ok) {
    const msg = json?.error?.message ?? `HTTP ${res.status}`;
    const err = new OpenRouterError(explain(res.status, msg, body.model), { status: res.status, transient: TRANSIENT.has(res.status) });
    err.retryAfterMs = Math.min(Number(res.headers?.get?.('retry-after') ?? 0) * 1000, RETRY_AFTER_CAP_MS);
    throw err;
  }
  if (!json) throw new OpenRouterError('OpenRouter returned a body that is not JSON', { status: res.status, transient: true });
  // An upstream failure can arrive as a 200 with an error and no choices.
  if (json.error && !json.choices) {
    const code = Number(json.error.code);
    throw new OpenRouterError(`OpenRouter: ${json.error.message ?? 'error with no message'}`,
      { status: code || null, transient: !code || TRANSIENT.has(code) });
  }
  return json;
}

function explain(status, msg, model) {
  if (status === 401) return 'OpenRouter rejected the key. Check OPENROUTER_API_KEY in .env.';
  if (status === 402) return `OpenRouter: out of credit, or the key's limit is reached (${msg}). Add credit or raise the key limit.`;
  if (status === 404 && /data policy|zdr|retention/i.test(msg)) {
    return `"${model}" has no zero-retention endpoint that does not collect data (${msg}). Not loosened: pick another model.`;
  }
  if (status === 404) return `OpenRouter: no endpoint for "${model}" with these parameters (${msg}).`;
  return `OpenRouter error ${status}: ${msg}`;
}

// ONE RETRY LAYER (diplomacy-A2A gateway_client.py): transient statuses,
// timeouts and malformed bodies are retried, honouring retry-after; anything
// else fails at once, because retrying a 400 only repeats it.
async function postWithRetry(body) {
  for (let attempt = 1; ; attempt++) {
    try { return await post(body); } catch (e) {
      if (!e.transient || attempt >= ATTEMPTS) throw e;
      await deps.sleep(e.retryAfterMs || 2000 * attempt);
    }
  }
}

/**
 * One call. Returns the answer in the shape complete() records:
 * {text, usage, cost_usd, stop_reason, provider, model}. `usage` uses the
 * Anthropic field names so one ledger insert serves both paths.
 */
export async function chat(opts) {
  const body = buildBody(opts);
  if (opts.tools) throw new Error('OpenRouter path has no server-side tools: web search stays on Claude');
  let json;
  try { json = await postWithRetry(body); } catch (e) {
    // PARAMETER STEP-DOWN (diplomacy-A2A): a model listed as taking reasoning
    // that no provider will serve with it gets one more try without.
    if (body.reasoning && [400, 404].includes(e.status)) {
      delete body.reasoning;
      console.warn(`  ${opts.model}: rejected reasoning (${e.message}); retrying without it`);
      json = await postWithRetry(body);
    } else throw e;
  }
  return answerOf(json, opts.model);
}

function answerOf(json, model) {
  const u = json.usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const usage = {
    input_tokens: Math.max((u.prompt_tokens ?? 0) - cached, 0),
    output_tokens: u.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
  const p = PRICING[json.model ?? model] ?? PRICING[model];
  const cost = typeof u.cost === 'number' ? u.cost
    : p ? (usage.input_tokens * p.in + cached * (p.cacheRead ?? p.in) + usage.output_tokens * p.out) / 1e6
      : null;
  const choice = json.choices?.[0];
  return {
    text: String(choice?.message?.content ?? '').trim(),
    usage, cost_usd: cost,
    stop_reason: choice?.finish_reason ?? null,
    provider: json.provider ?? null,
    model: json.model ?? model,
  };
}

/**
 * JSON from a model's text, even when a schema was asked for and not kept:
 * as given; else the outermost {...}; else that with trailing commas removed
 * (portfolio-wave-rider, curator.py). Returns null when none parses.
 */
export function parseJson(text) {
  const tries = [text];
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    const inner = text.slice(a, b + 1);
    tries.push(inner, inner.replace(/,\s*([}\]])/g, '$1'));
  }
  for (const t of tries) { try { return JSON.parse(t); } catch { /* next */ } }
  return null;
}
