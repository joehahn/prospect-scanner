// One tiny call per OpenRouter model, to see that each answers at all under
// this project's rules: zero-retention hosts only, strict JSON, reasoning on.
// Cents. Run once per new model id before it is measured on real work.
//
//   node --env-file=.env scripts/smoke-openrouter.mjs [model ...]
import { openDb, startRun, finishRun } from '../src/db.mjs';
import { complete } from '../src/models.mjs';
import { knownOpenRouterModels } from '../src/openrouter.mjs';

const models = process.argv.slice(2).length ? process.argv.slice(2) : knownOpenRouterModels();
const schema = { type: 'object', properties: { sum: { type: 'integer' }, word: { type: 'string' } },
  required: ['sum', 'word'], additionalProperties: false };
const db = openDb();
const run = startRun(db, 'smoke', { notes: 'OpenRouter smoke test' });
let total = 0;
for (const model of models) {
  const t0 = Date.now();
  try {
    const r = await complete(db, run, { model, maxTokens: 2000, effort: 'low', schema,
      system: 'Answer in the JSON the schema asks for.',
      messages: [{ role: 'user', content: 'What is 17 + 25? Also give one word for the colour of a clear daytime sky.' }] });
    total += r.cost_usd ?? 0;
    const ok = r.data?.sum === 42;
    console.log(`${ok ? 'ok  ' : 'WRONG'} ${model.padEnd(30)} ${String(r.provider).padEnd(14)} ` +
      `${((Date.now() - t0) / 1000).toFixed(1)}s  $${(r.cost_usd ?? 0).toFixed(5)}  ${JSON.stringify(r.data)}`);
  } catch (e) {
    console.log(`FAIL  ${model.padEnd(30)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${e.message.slice(0, 200)}`);
  }
}
finishRun(db, run, { n_in: models.length });
console.log(`\n${models.length} models, $${total.toFixed(4)}`);
