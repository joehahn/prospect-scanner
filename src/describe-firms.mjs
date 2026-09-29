// Re-describe firms in one plain sentence, from what was already read off their sites.
//
// `enrich` v1 stored "what they do" in the firm's own words, which for a
// consumer brand is a slogan ("Sell your home the minute you're ready."). This
// rewrites that line from the facts already on file, one cheap call per firm,
// fetching nothing. The original is kept in the evidence body.
//
// Usage:
//   npm run describe                every firm with a site profile
//   npm run describe -- --org <id>  one firm

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { complete } from './models.mjs';
import { heading, dim } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = 'prompts/describe-firm.md';
const SCHEMA = { type: 'object', additionalProperties: false, required: ['what_they_do'],
  properties: { what_they_do: { type: 'string' } } };

const args = process.argv.slice(2);
const one = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;
const db = openDb();
const cfg = loadConfig();
const model = cfg.models?.cheap;
const system = readFileSync(resolve(ROOT, PROMPT_FILE), 'utf8');

// The latest site profile per firm.
const rows = db.prepare(`SELECT e.id, e.org_id, e.claim, e.body, o.name FROM evidence e JOIN orgs o ON o.id = e.org_id
    WHERE e.kind = 'firm_profile' AND e.person_id IS NULL
      AND e.id = (SELECT MAX(x.id) FROM evidence x WHERE x.org_id = e.org_id AND x.kind = 'firm_profile' AND x.person_id IS NULL)
      ${one ? 'AND e.org_id = ?' : ''} ORDER BY o.name`).all(...(one ? [one] : []));

console.log(heading(`describe · ${rows.length} firm(s) · ${model}`));
const runId = startRun(db, 'describe', { model });
const upd = db.prepare('UPDATE evidence SET claim = ?, body = ? WHERE id = ?');
let done = 0; let empty = 0;

async function one1(r) {
  let data = {};
  try { data = JSON.parse(r.body ?? '{}'); } catch { data = {}; }
  const facts = (data.evidence ?? []).map((e) => `- ${e.claim}${e.quote ? ` ("${String(e.quote).slice(0, 200)}")` : ''}`).join('\n');
  const content = `## Firm\n${r.name}\n\n## Summary written at the time\n${r.claim}\n\n## Facts read off its site\n${facts || '(none)'}`
    + (data.staffs_capability ? `\n\n## Roles it lists\n${String(data.staffs_capability).slice(0, 300)}` : '');
  const res = await complete(db, runId, { model, system, schema: SCHEMA, effort: 'low', thinking: false,
    maxTokens: 300, messages: [{ role: 'user', content: content.slice(0, 6000) }] });
  const line = String(res.data?.what_they_do ?? '').trim();
  if (!line) { empty++; return; }
  data.what_they_do_original ??= data.what_they_do ?? r.claim;
  data.what_they_do = line;
  data.described_by = PROMPT_FILE;
  upd.run(line, JSON.stringify(data, null, 1), r.id);
  done++;
}

// A few at a time: cheap calls, and the rate limiter in complete() paces them.
for (let i = 0; i < rows.length; i += 8) {
  await Promise.all(rows.slice(i, i + 8).map((r) => one1(r).catch((e) => console.log(dim(`  ${r.name}: ${e.message}`)))));
  process.stdout.write(dim(`  ${Math.min(i + 8, rows.length)}/${rows.length}\r`));
}
finishRun(db, runId, {});
const cost = db.prepare('SELECT ROUND(SUM(cost_usd), 3) c FROM runs WHERE id = ?').get(runId)?.c ?? 0;
console.log(heading(`${done} re-described · ${empty} left as they were (the facts did not say) · $${cost}`));
