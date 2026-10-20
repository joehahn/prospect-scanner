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
// From OpenRouter's /models `supported_parameters`, 2026-10-19, and kept only
// where the smoke test (scripts/smoke-openrouter.mjs) got an answer with it.
// `hosts` pins the providers a model may run on, so a measurement and the live
// stage use the same one: price and behaviour differ by host.
const CAPABILITIES = {
  // Pinned to ModelRun (fp8). On CoreWeave (fp4) it reasoned a fifth as much
  // and its judge verdicts matched the operator 78% against 86% on ModelRun,
  // 2026-10-19: same id, different model in practice.
  // schemaInPrompt: ModelRun stopped taking a strict json_schema on 2026-10-20
  // (still zero-retention; its json_object mode answered "{}"), and every judge
  // call failed for a day. The schema goes in the request and checkSchema holds
  // the answer to it instead of the host.
  'minimax/minimax-m3':           { reasoning: true, hosts: ['modelrun'], schemaInPrompt: true },
  'deepseek/deepseek-v4.1-flash': { reasoning: true, hosts: ['baseten'] },   // the host its judge run used
  'openai/gpt-5.6-luna':          { reasoning: true },
  'anthropic/claude-haiku-5.5':   { reasoning: true },
  'z-ai/glm-5.3':                 { reasoning: true },
  'qwen/qwen3.8-27b':             { reasoning: true },
  'moonshotai/kimi-k2.6':         { reasoning: true },
};
const capsFor = (model) => CAPABILITIES[model] ?? { reasoning: false };

// USD per 1M tokens, used only when a response carries no billed cost. The
// billed `usage.cost` is the record; this keeps a missing one from reading $0.
// From OpenRouter's /models, 2026-10-19; prices vary by host and change often.
const PRICING = {
  'minimax/minimax-m3':           { in: 0.30, out: 1.20, cacheRead: 0.06 },
  'deepseek/deepseek-v4.1-flash': { in: 0.03, out: 0.08, cacheRead: 0.002 },
  'openai/gpt-5.6-luna':          { in: 0.20, out: 1.20, cacheRead: 0.02 },
  'anthropic/claude-haiku-5.5':   { in: 0.10, out: 0.50, cacheRead: 0.01 },
  'z-ai/glm-5.3':                 { in: 0.08, out: 1.40, cacheRead: 0.078 },
  'qwen/qwen3.8-27b':             { in: 0.24, out: 2.20, cacheRead: 0.05 },
  'moonshotai/kimi-k2.6':         { in: 0.65, out: 3.41, cacheRead: 0.15 },
};

export function knownOpenRouterModels() { return Object.keys(PRICING); }
export const isOpenRouter = (model) => !String(model).startsWith('claude-');

// Swappable for tests, so retries neither hit the network nor wait.
export const deps = {
  fetch: (...a) => globalThis.fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  key: () => process.env.OPENROUTER_API_KEY,
};

// 520-524 are Cloudflare's "the host behind me is down", which is what a busy
// open-weight provider returns (ModelRun, 9 of 150 judge calls, 2026-10-19).
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
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
    provider: { require_parameters: true, data_collection: 'deny', zdr: true,
      ...(caps.hosts ? { only: caps.hosts, allow_fallbacks: false } : {}) },
    usage: { include: true },
  };
  if (thinking && caps.reasoning) body.reasoning = { effort: effort === 'max' ? 'high' : effort };
  if (schema && caps.schemaInPrompt) {
    body.messages.push({ role: 'user', content: 'Reply with only one JSON object, no other text, matching this '
      + `JSON Schema exactly (every required key, values only from each enum):\n${JSON.stringify(schema)}` });
  } else if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } };
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

/**
 * What is wrong with an answer, against the subset of JSON Schema the stages
 * use (object, required, enum, type string/number/integer/boolean/array,
 * additionalProperties false); [] when nothing is. A host that enforced the
 * schema made this unnecessary; one that does not leaves it to us.
 */
export function checkSchema(data, schema, path = '') {
  const at = path || 'the answer';
  const t = schema?.type;
  if (t === 'object') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return [`${at} is not an object`];
    const out = [];
    for (const k of schema.required ?? []) if (!(k in data)) out.push(`missing "${k}"`);
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(data)) if (!(k in (schema.properties ?? {}))) out.push(`unexpected "${k}"`);
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in data) out.push(...checkSchema(data[k], sub, `"${k}"`));
    }
    return out;
  }
  const ok = { string: (v) => typeof v === 'string', number: (v) => typeof v === 'number',
    integer: (v) => Number.isInteger(v), boolean: (v) => typeof v === 'boolean', array: (v) => Array.isArray(v) }[t];
  if (ok && !ok(data)) return [`${at} should be a ${t}`];
  if (schema?.enum && !schema.enum.includes(data)) return [`${at} is ${JSON.stringify(data)}, not one of ${schema.enum.join(', ')}`];
  if (t === 'array' && schema.items) return data.flatMap((x, i) => checkSchema(x, schema.items, `${at}[${i}]`));
  return [];
}
