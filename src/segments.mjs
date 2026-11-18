// One industry segment per firm, for the Results page's "how outreach lands
// by industry" panel. One cheap call per firm, fetching nothing.
//
// The firm records had no common industry field (2026-11-18): a free-text
// line on a few dozen firms, and buying-signal categories (`org_verticals`)
// that are not industries. The segment list is generic on purpose, so the
// panel reads the same for any business that runs this.
//
// Usage:
//   npm run segments              firms written to that have no segment yet
//   npm run segments -- --org <id>
//   npm run segments -- --redo    every firm written to, again

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { complete } from './models.mjs';
import { heading, dim } from './report.mjs';
import { SEGMENTS } from './outcomes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = 'prompts/label-segment.md';

export { SEGMENTS };

const SCHEMA = { type: 'object', additionalProperties: false, required: ['segment', 'basis'],
  properties: { segment: { type: 'string', enum: Object.keys(SEGMENTS) },
    basis: { type: 'string', enum: ['on_file', 'name_known', 'guess'] } } };

async function main() {
  const args = process.argv.slice(2);
  const one = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;
  const redo = args.includes('--redo');
  const db = openDb();
  const model = loadConfig().models?.cheap;
  const system = readFileSync(resolve(ROOT, PROMPT_FILE), 'utf8');

  const rows = db.prepare(`SELECT o.id, o.name, o.domain, o.industry, o.kind,
      (SELECT e.claim FROM evidence e WHERE e.org_id = o.id AND e.kind = 'firm_profile' AND e.person_id IS NULL
        ORDER BY e.id DESC LIMIT 1) AS what,
      (SELECT group_concat(title, ' | ') FROM (SELECT DISTINCT p.title FROM people p WHERE p.org_id = o.id AND p.title IS NOT NULL LIMIT 4)) AS titles
    FROM orgs o
    WHERE ${one ? 'o.id = ?' : `EXISTS (SELECT 1 FROM outreach x WHERE x.org_id = o.id AND x.seeded = 0)${redo ? '' : ' AND o.segment IS NULL'}`}
    ORDER BY o.name`).all(...(one ? [one] : []));

  console.log(heading(`segments · ${rows.length} firm(s) · ${model}`));
  if (!rows.length) return;
  const runId = startRun(db, 'segments', { model });
  const upd = db.prepare('UPDATE orgs SET segment = ?, segment_basis = ?, segment_at = ? WHERE id = ?');
  const tally = {};
  const label = async (r) => {
    const content = [`## Firm\n${r.name}`, r.domain && `## Domain\n${r.domain}`, r.industry && `## Industry line on file\n${r.industry}`,
      r.what && `## What it does, on file\n${r.what}`, r.titles && `## Titles of people there\n${r.titles}`].filter(Boolean).join('\n\n');
    const res = await complete(db, runId, { model, system, schema: SCHEMA, effort: 'low', thinking: false,
      maxTokens: 400, messages: [{ role: 'user', content: content.slice(0, 4000) }] });
    const seg = res.data?.segment;
    if (!SEGMENTS[seg]) return;
    upd.run(seg, res.data.basis ?? 'guess', new Date().toISOString(), r.id);
    tally[seg] = (tally[seg] ?? 0) + 1;
  };
  for (let i = 0; i < rows.length; i += 8) {
    await Promise.all(rows.slice(i, i + 8).map((r) => label(r).catch((e) => console.log(dim(`  ${r.name}: ${e.message}`)))));
    process.stdout.write(dim(`  ${Math.min(i + 8, rows.length)}/${rows.length}\r`));
  }
  finishRun(db, runId, {});
  const cost = db.prepare('SELECT ROUND(SUM(cost_usd), 3) c FROM runs WHERE id = ?').get(runId)?.c ?? 0;
  console.log(heading(`${Object.values(tally).reduce((a, b) => a + b, 0)} labeled · $${cost}`));
  for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${SEGMENTS[k]}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
