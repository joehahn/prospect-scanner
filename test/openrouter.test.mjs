// The OpenRouter path, against a mocked fetch: nothing reaches the network.
//
// What must hold: every request asks for endpoints that keep and train on
// nothing; every call is recorded with its billed cost and provider, even one
// that fails; an empty answer is a failure, never ""; transient statuses are
// retried and others are not; a schema reply is repaired or asked for again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deps, parseJson, isOpenRouter } from '../src/openrouter.mjs';
import { openDb, startRun } from '../src/db.mjs';
import { complete } from '../src/models.mjs';

const dir = mkdtempSync(join(tmpdir(), 'openrouter-'));
const db = openDb(join(dir, 'test.db'));
test.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

deps.key = () => 'sk-or-test';
deps.sleep = async () => {};
const sent = [];
const reply = (status, body, headers = {}) => ({ ok: status < 300, status, json: async () => body,
  headers: { get: (h) => headers[h.toLowerCase()] ?? null } });
const answer = (content, extra = {}) => reply(200, {
  model: 'test/model', provider: 'TestHost',
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0012, prompt_tokens_details: { cached_tokens: 40 } },
  ...extra });
function script(...replies) {
  sent.length = 0;
  deps.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return replies.shift(); };
}
const lastCall = () => db.prepare('SELECT * FROM llm_calls ORDER BY id DESC LIMIT 1').get();
const calls = (run) => db.prepare('SELECT count(*) n FROM llm_calls WHERE run_id = ?').get(run).n;
const ask = (run, o = {}) => complete(db, run, { model: 'test/model', system: 'sys',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], ...o });

test('only claude-* ids stay on Anthropic', () => {
  assert.equal(isOpenRouter('claude-sonnet-5'), false);
  assert.equal(isOpenRouter('deepseek/deepseek-v4.1-flash'), true);
});

test('every request refuses endpoints that keep or collect data', async () => {
  script(answer('ok'));
  await ask(startRun(db, 'test'));
  assert.deepEqual(sent[0].provider, { require_parameters: true, data_collection: 'deny', zdr: true });
  assert.deepEqual(sent[0].messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  // Nothing optional is sent to a model not listed as taking it.
  assert.equal(sent[0].reasoning, undefined);
  assert.equal(sent[0].temperature, undefined);
});

test('a call is recorded with billed cost, provider and tokens net of cache', async () => {
  const run = startRun(db, 'test');
  script(answer('ok'));
  const r = await ask(run);
  assert.equal(r.text, 'ok');
  const row = lastCall();
  assert.equal(row.provider, 'TestHost');
  assert.equal(row.cost_usd, 0.0012);
  assert.equal(row.input_tokens, 60);
  assert.equal(row.cache_read_tokens, 40);
  assert.equal(db.prepare('SELECT cost_usd FROM runs WHERE id = ?').get(run).cost_usd, 0.0012);
});

test('an empty answer on a 200 is a counted failure', async () => {
  const run = startRun(db, 'test');
  script(answer('', { choices: [{ message: { content: '' }, finish_reason: 'length' }] }));
  await assert.rejects(ask(run), /returned no text \(finish_reason length\)/);
  assert.equal(calls(run), 1);
});

test('transient statuses are retried, honouring retry-after; others fail at once', async () => {
  let waited = [];
  deps.sleep = async (ms) => { waited.push(ms); };
  script(reply(429, { error: { message: 'slow down' } }, { 'retry-after': '7' }), reply(503, {}), answer('ok'));
  assert.equal((await ask(startRun(db, 'test'))).text, 'ok');
  assert.equal(sent.length, 3);
  assert.equal(waited[0], 7000);
  script(reply(400, { error: { message: 'bad request' } }), answer('never'));
  await assert.rejects(ask(startRun(db, 'test')), /error 400: bad request/);
  assert.equal(sent.length, 1);
  script(reply(402, { error: { message: 'Insufficient credits' } }));
  await assert.rejects(ask(startRun(db, 'test')), /out of credit/);
  deps.sleep = async () => {};
});

test('no zero-retention endpoint fails plainly and is not loosened', async () => {
  script(reply(404, { error: { message: 'No endpoints found matching your data policy' } }));
  await assert.rejects(ask(startRun(db, 'test')), /no zero-retention endpoint.*Not loosened/);
  assert.equal(sent.length, 1);
});

test('a 200 carrying an upstream error is retried', async () => {
  script(reply(200, { error: { code: 502, message: 'upstream died' } }), answer('ok'));
  assert.equal((await ask(startRun(db, 'test'))).text, 'ok');
});

test('a schema is sent strict, and a reply wrapped in prose is repaired', async () => {
  const schema = { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'], additionalProperties: false };
  script(answer('Here you go: {"a": 1,}'));
  const r = await ask(startRun(db, 'test'), { schema });
  assert.deepEqual(r.data, { a: 1 });
  assert.equal(sent[0].response_format.json_schema.strict, true);
});

test('unparseable JSON is asked for once more, both calls recorded, then fails with the raw text', async () => {
  const schema = { type: 'object' };
  let run = startRun(db, 'test');
  script(answer('not json'), answer('{"a": 2}'));
  assert.deepEqual((await ask(run, { schema })).data, { a: 2 });
  assert.equal(calls(run), 2);
  assert.match(sent[1].messages.at(-1).content, /not valid JSON/);
  run = startRun(db, 'test');
  script(answer('nope'), answer('still nope'));
  await assert.rejects(ask(run, { schema }), (e) => e.raw === 'still nope');
  assert.equal(calls(run), 2);
});

test('web search is refused rather than dropped', async () => {
  script(answer('ok'));
  await assert.rejects(ask(startRun(db, 'test'), { tools: [{ type: 'web_search_20260209' }] }), /no server-side tools/);
  assert.equal(sent.length, 0);
});

test('parseJson takes the outermost object and drops trailing commas', () => {
  assert.deepEqual(parseJson('```json\n{"a":[1,2,],}\n```'), { a: [1, 2] });
  assert.equal(parseJson('no braces'), null);
});
