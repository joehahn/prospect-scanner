// Every LLM call in this system goes through here.
//
// CLAUDE.md: "Every LLM call records model, tokens and cost into the runs table.
// The cost study depends on it and cannot be retrofitted." That is the whole
// reason this module exists rather than each stage calling the SDK directly —
// there is no code path that can spend money without being counted.
//
// Model ids come from config/runtime.yml (models.default / cheap / grader), never
// hard-coded here. Only the price list is local, because prices are a property
// of the API, not of the operator's configuration.

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';

// Not every model takes every parameter, and sending one that a model does not
// support is a 400, not a graceful degradation. `claude-haiku-4-5` rejects both
// adaptive thinking and output_config.effort — which matters because the cheap
// model is the one the enrich stage runs on.
//
// `thinking` here means the adaptive form. Older models take the removed
// budget_tokens form instead, which this system does not use.
const CAPABILITIES = {
  // Opus 5.5 and Sonnet 5.5 reject thinking: {type: "disabled"}; omitting it
  // runs adaptive, which is what thinking: false sends below.
  'claude-opus-5-5':   { thinking: true, effort: true },
  'claude-sonnet-5-5': { thinking: true, effort: true },
  'claude-fable-5-1':  { thinking: true, effort: true },
  'claude-opus-5':     { thinking: true, effort: true },
  'claude-opus-4-8':   { thinking: true, effort: true },
  'claude-opus-4-7':   { thinking: true, effort: true },
  'claude-opus-4-6':   { thinking: true, effort: true },
  'claude-fable-5':    { thinking: true, effort: true },
  'claude-sonnet-5':   { thinking: true, effort: true },
  'claude-sonnet-4-6': { thinking: true, effort: true },
  'claude-haiku-4-5':  { thinking: false, effort: false },
};

// An unknown model gets the conservative shape: send neither, so a new id fails
// on price bookkeeping rather than on a parameter rejection.
const capsFor = (model) => CAPABILITIES[model] ?? { thinking: false, effort: false };

// USD per 1M tokens. `intro_until` handles promotional pricing so the cost
// study stays accurate across the boundary instead of silently overstating.
const PRICING = {
  // cacheRead overrides the usual 0.1x where a model's cache reads are priced
  // apart: $0.20/MTok on Opus 5.5 (0.05x), $0.25/MTok on Fable 5.1 (0.025x).
  'claude-opus-5-5':   { in: 4.00, out: 20.00, cacheRead: 0.05 },
  'claude-sonnet-5-5': { in: 2.00, out: 10.00 },
  'claude-fable-5-1':  { in: 10.00, out: 50.00, cacheRead: 0.025 },
  'claude-opus-5':     { in: 5.00, out: 25.00 },
  'claude-opus-4-8':   { in: 5.00, out: 25.00 },
  'claude-opus-4-7':   { in: 5.00, out: 25.00 },
  'claude-opus-4-6':   { in: 5.00, out: 25.00 },
  'claude-fable-5':    { in: 10.00, out: 50.00 },
  // $2/$10 was announced as introductory through 2026-08-31 and then MADE
  // PERMANENT — the scheduled rise to $3/$15 on 2026-09-01 was cancelled.
  // Checked against the pricing page 2026-09-11. Until then this file expired
  // the intro rate on schedule and billed every Sonnet call after 1 September at
  // 1.5x its real cost, which is the one error the runs table must not make.
  'claude-sonnet-5':   { in: 2.00, out: 10.00 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
  'claude-haiku-4-5':  { in: 1.00, out: 5.00 },
};

// Cached reads bill at ~0.1x, cache writes at ~1.25x of the input rate.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export function knownModels() {
  return Object.keys(PRICING);
}

/** Price for one call. Unknown models cost null rather than 0 — a silent zero would corrupt the study. */
export function priceOf(model, usage, onDate = new Date().toISOString().slice(0, 10)) {
  const p = PRICING[model];
  if (!p) return null;
  const rate = p.intro && onDate <= p.intro_until ? p.intro : p;
  const inTok = usage?.input_tokens ?? 0;
  const outTok = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  return (
    (inTok * rate.in
      + cacheRead * rate.in * (p.cacheRead ?? CACHE_READ_MULTIPLIER)
      + cacheWrite * rate.in * CACHE_WRITE_MULTIPLIER
      + outTok * rate.out) / 1_000_000
  );
}

// ---- batch mode -----------------------------------------------------------
// HALF PRICE FOR WORK NOBODY IS WAITING ON. Added 2026-10-02. The morning run's
// judging, screening and grading are read hours after they finish, and the
// Batches API bills the same model, prompt and output at 50%. With
// CLAUDE_BATCH=1 in the environment, complete() queues its request instead of
// sending it; a queue that has been quiet for BATCH_GATHER_MS goes out as one
// batch, and each caller's promise resolves with its own result. Nothing about
// the request changes, so nothing about the answer does.
//
// THE MORNING CANNOT STALL ON IT. Most batches end within the hour, but the
// limit is a day. Past CLAUDE_BATCH_WAIT_MIN (default 40) the batch is
// cancelled and whatever has not come back is sent the ordinary way, at full
// price, and recorded as such.
const BATCH_GATHER_MS = 3000;
const batchQueue = [];
let gatherTimer = null;
export const batchMode = () => process.env.CLAUDE_BATCH === '1';

function enqueue(req) {
  return new Promise((resolve, reject) => {
    batchQueue.push({ req, resolve, reject });
    clearTimeout(gatherTimer);
    gatherTimer = setTimeout(() => { flushBatch().catch((e) => console.error(`batch failed: ${e.message}`)); },
      BATCH_GATHER_MS);
  });
}

async function flushBatch() {
  const items = batchQueue.splice(0);
  if (!items.length) return;
  const api = getClient();
  const sendDirect = async (it) => {
    try { it.resolve({ res: await api.messages.create(it.req), batched: false }); }
    catch (e) { it.reject(e); }
  };
  let batch;
  try {
    batch = await api.messages.batches.create({
      requests: items.map((it, i) => ({ custom_id: `r${i}`, params: it.req })) });
  } catch (e) {
    console.error(`  batch not accepted (${e.message}); sending ${items.length} call(s) directly`);
    await Promise.all(items.map(sendDirect));
    return;
  }
  const deadline = Date.now() + Number(process.env.CLAUDE_BATCH_WAIT_MIN ?? 40) * 60_000;
  console.error(`  batch ${batch.id}: ${items.length} call(s) at half price, waiting for results`);
  while (batch.processing_status !== 'ended' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000));
    batch = await api.messages.batches.retrieve(batch.id);
  }
  if (batch.processing_status !== 'ended') {
    console.error(`  batch ${batch.id} still running at the deadline: cancelling, the rest go direct`);
    await api.messages.batches.cancel(batch.id).catch(() => {});
    // A cancel takes a moment to settle; results are only readable once ended.
    for (let i = 0; i < 20 && batch.processing_status !== 'ended'; i++) {
      await new Promise((r) => setTimeout(r, 3_000));
      batch = await api.messages.batches.retrieve(batch.id);
    }
  }
  const done = new Set();
  if (batch.processing_status === 'ended') {
    for await (const r of await api.messages.batches.results(batch.id)) {
      const it = items[Number(String(r.custom_id).slice(1))];
      if (!it) continue;
      if (r.result.type === 'succeeded') { it.resolve({ res: r.result.message, batched: true }); done.add(it); }
    }
  }
  // Errored, expired, cancelled, or never read: the ordinary way, so a caller
  // never waits on a request that is not coming.
  await Promise.all(items.filter((it) => !done.has(it)).map(sendDirect));
}

let client = null;
function getClient() {
  // The SDK resolves credentials itself: ANTHROPIC_API_KEY, then
  // ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile. Do not demand a key.
  if (!client) client = new Anthropic();
  return client;
}

/**
 * One Claude call, priced and recorded.
 *
 * @param db        open database, so the cost lands in `runs` before it can be lost
 * @param runId     the run this call belongs to
 * @param model     model id from config/runtime.yml
 * @returns {text, usage, cost_usd, model, stop_reason}
 */
export async function complete(db, runId, {
  model,
  system,
  messages,
  maxTokens = 4000,
  effort = 'high',
  thinking = true,
  cacheSystem = true,
  schema = null,
  tools = null,
}) {
  if (!model) throw new Error('complete() needs a model id from config/runtime.yml');

  const caps = capsFor(model);
  const req = { model, max_tokens: maxTokens, messages };

  if (caps.effort) req.output_config = { effort };
  // Adaptive thinking where the model takes it. The fixed budget_tokens form is
  // removed on the current family and returns a 400, so it is never sent.
  if (thinking && caps.thinking) req.thinking = { type: 'adaptive' };

  // Extraction stages want a shape they can rely on. Constrain the response
  // rather than parsing prose and hoping.
  if (schema) {
    req.output_config = { ...req.output_config, format: { type: 'json_schema', schema } };
  }

  // Server-side tools. The only one used here is web search, scoped to a single
  // allowed domain by the caller — see news --promote. Declared per call rather
  // than globally so no stage acquires a retrieval affordance by accident.
  if (tools) req.tools = tools;

  if (system) {
    // The system prompt here is the voice file plus firm config — stable across
    // calls and large enough to cache, so it is the natural breakpoint.
    req.system = cacheSystem
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system;
  }

  let res;
  let batched = false;
  try {
    if (batchMode()) {
      ({ res, batched } = await enqueue(req));
    } else {
      // STREAM WHEN THE CEILING IS HIGH. The SDK refuses a non-streaming request
      // whose max_tokens implies it could run past ten minutes, and refuses it
      // CLIENT-SIDE — so it costs nothing and reads like a model failure rather
      // than a config one. Tuning the ceiling under that threshold was tried
      // twice on 2026-09-21 and is the wrong fix: it caps how long a stage may
      // think for a reason that has nothing to do with the work.
      //
      // `.stream()` with `finalMessage()` returns the same shape the rest of this
      // function already reads, so nothing downstream changes. Below the
      // threshold the plain call is kept: it is simpler and the limit is real.
      res = maxTokens > 16000
        ? await getClient().messages.stream(req).finalMessage()
        : await getClient().messages.create(req);
    }
  } catch (err) {
    // Credential resolution fails before the request is sent, so this is not an
    // AuthenticationError and the SDK's own message does not say what to do.
    if (/resolve authentication method/i.test(err?.message ?? '')) {
      throw new Error(
        'No Claude credentials found. This stage is the first one that calls the API.\n' +
        '  Either export a key:      export ANTHROPIC_API_KEY=sk-ant-...\n' +
        '  or log in with the CLI:   ant auth login   (stores a profile the SDK reads)\n' +
        'Nothing was spent and nothing was recorded.');
    }
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error('Claude rejected the credentials. Run `ant auth login`, ' +
        'or export ANTHROPIC_API_KEY.');
    }
    if (err instanceof Anthropic.NotFoundError) {
      throw new Error(`Model "${model}" was not found. Check models.* in ` +
        `config/runtime.yml (models.*) against: ${knownModels().join(', ')}`);
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error('Rate limited by the Claude API. Retry in a moment.');
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`Claude API error ${err.status}: ${err.message}`);
    }
    throw err;
  }

  // $10 per 1,000 searches, on top of tokens, and an errored search is not
  // billed. Uncounted, a stage that searches would look as cheap as one that
  // does not, and the cost-per-qualified-prospect number would be wrong in the
  // one direction that flatters the system.
  const searches = res.usage?.server_tool_use?.web_search_requests ?? 0;
  // The Batches API bills tokens at half the listed rate.
  const tokenCost = priceOf(model, res.usage);
  const cost = (tokenCost ?? 0) * (batched ? 0.5 : 1) + searches * 0.01;
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

  // With adaptive thinking on, max_tokens covers thinking AND the answer. Too
  // low a ceiling produces a billed call with an empty response, which is worse
  // than an error because it looks like the model had nothing to say.
  // Recorded before the caller gets a chance to throw. A call that happened and
  // was not counted is worse than a call that failed.
  //
  // MOVED ABOVE THE max_tokens THROW, 2026-09-21. The throw below said "the call
  // was billed and has been recorded" and then skipped this, so a drafting call
  // that burned 16,000 tokens and returned nothing was written to `runs` at
  // $0.00. CLAUDE.md makes this a hard guardrail — every LLM call records model,
  // tokens and cost, and the cost study cannot be retrofitted — and the one call
  // shape guaranteed to be expensive and produce nothing was the one exempt.
  // The run's running cost, and one ledger row for this call. n_in/n_out on
  // the run are the stage's item counts; tokens live in llm_calls, per call,
  // with the model that actually answered.
  db.prepare(`UPDATE runs SET model = COALESCE(model, ?), cost_usd = COALESCE(cost_usd, 0) + ? WHERE id = ?`)
    .run(model, cost ?? 0, runId);
  db.prepare(`INSERT INTO llm_calls (run_id, stage, model, at, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, web_searches, cost_usd, stop_reason, batch)
    VALUES (?, (SELECT stage FROM runs WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(runId, runId, model, new Date().toISOString(), res.usage?.input_tokens ?? 0,
      res.usage?.output_tokens ?? 0, res.usage?.cache_read_input_tokens ?? 0,
      res.usage?.cache_creation_input_tokens ?? 0, searches,
      tokenCost === null ? null : cost, res.stop_reason ?? null, batched ? 1 : 0);

  if (!text && res.stop_reason === 'max_tokens') {
    throw new Error(
      `${model} hit max_tokens (${maxTokens}) while thinking and produced no text ` +
      `— $${(cost ?? 0).toFixed(4)} spent, now recorded against this run. ` +
      'Raise maxTokens for this stage.');
  }

  if (cost === null) {
    console.warn(`no price on file for "${model}" — this call is recorded at $0 ` +
      'and the cost study will understate it. Add it to PRICING in src/models.mjs.');
  }
  if (res.stop_reason === 'refusal') {
    throw new Error(`Claude declined this request (${res.stop_details?.category ?? 'unspecified'}): ` +
      (res.stop_details?.explanation ?? 'no explanation given'));
  }

  let data = null;
  if (schema) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(`model returned unparseable JSON despite a schema: ${err.message}`);
    }
  }

  return { text, data, usage: res.usage, cost_usd: cost, model, stop_reason: res.stop_reason };
}

/**
 * A prompt file's text for the model: everything after the header's `---` line.
 * The header (version, why) is for people; `{{key}}` placeholders are filled from
 * `vars`, for the few prompts that name the person they are about.
 */
export function promptBody(file, vars = {}) {
  const root = new URL('..', import.meta.url);
  const raw = readFileSync(new URL(file, root), 'utf8');
  const at = raw.indexOf('\n---\n');
  if (at < 0) throw new Error(`${file}: no --- line after the header`);
  const body = raw.slice(at + 5).replace(/^\n/, '').replace(/\n$/, '');
  return body.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
