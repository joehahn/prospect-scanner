// Stage 2b: put a number on firms nobody has sized, by recall, and say so.
//
// THE MONEY GATE WAS READING "UNKNOWN" AS "SMALL". 374 of 411 firms on file had
// no revenue figure, and for every one of them the router reported "end client
// below the hands-on money gate ... sell hours instead". It had not decided they
// were small. It had no number and reached for the cheapest offer on the menu.
// A two-billion-dollar organisation was being pitched a single billable hour.
//
// That is the same error the persona headcount rule exists to stop: an unsized
// firm is not a small firm, it is an unsized one. The difference is that the
// persona rule could refuse to promote on missing data, and the money gate has
// to price something.
//
// SO RECALL IS THE ANSWER, AND IT IS ALREADY THIS PROJECT'S PRACTICE. `events`
// sizes conference firms by asking a model what it already knows, stores
// headcount_source='recalled', and prints "RECALLED, not retrieved" into the
// evidence body. This does the same for revenue, with the same discipline: a
// zero means the model does not know, and a zero is an honest answer where a
// guessed number decides something.
//
// THE OPERATOR'S OWN FRAMING, 2026-09-23: "cant we guestimate revenue from
// prospect's job title and firm" -- pointing at a CFO whose role covers
// "finance, budgeting, real estate, technology, investments, and business
// operations" at a named organisation. That is enough for a competent person to
// size, and it is enough here.
//
// A BUDGET IS NOT REVENUE. For a union, a charity, a school or a public body the
// meaningful number is an operating budget, and calling it revenue would let a
// $2bn budget read as $2bn of sales. revenue_basis records which one it is.
//
// Never overwrites a retrieved figure with a recalled one.
//
// Usage:
//   npm run size -- [--unsized] [--org <id>] [--limit N] [--jobs 4] [--dry] [--redo]
//   npm run size -- --accuracy      how well recalled figures have held up

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun, recordSize } from './db.mjs';
import { loadConfig } from './config.mjs';
import { complete, promptBody } from './models.mjs';
import { heading, bold, dim } from './report.mjs';

const SYSTEM = promptBody('prompts/size-firm.md');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['amount_usd', 'basis', 'confidence', 'why'],
  properties: {
    amount_usd: { type: 'integer', description: 'Annual figure in USD. 0 if you do not know.' },
    basis: { type: 'string', enum: ['revenue', 'budget', 'aum', 'unknown'] },
    confidence: { type: 'string', enum: ['firm', 'loose'] },
    why: { type: 'string', description: 'One sentence: what you are reasoning from.' },
  },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2); const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) args[k] = true; else { args[k] = n; i++; }
  }
  return args;
}
const str = (v) => (v && v !== true ? String(v) : null);
const usd = (n) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}bn` : n >= 1e6 ? `$${Math.round(n / 1e6)}m` : `$${n}`);

// THE WHOLE REASON BOTH COLUMNS ARE KEPT. Every firm where somebody later found
// a real figure is a free test of the guess that preceded it, and this is the
// only way this project will ever learn whether recalled sizing can be trusted.
// Until enough rows accumulate it prints almost nothing, and that is honest:
// 293 firms were sized from memory in one pass and NONE of them has been checked.
function accuracy(db) {
  const rows = db.prepare(`
    SELECT name, revenue_recalled r, revenue_found f, 'revenue' metric FROM orgs
     WHERE revenue_recalled IS NOT NULL AND revenue_found IS NOT NULL
    UNION ALL
    SELECT name, headcount_recalled, headcount_found, 'headcount' FROM orgs
     WHERE headcount_recalled IS NOT NULL AND headcount_found IS NOT NULL`).all();

  console.log(heading('RECALL vs FOUND'));
  if (!rows.length) {
    console.log('  No firm has both a recalled figure and a found one yet, so the');
    console.log('  accuracy of recalled sizing is UNMEASURED.');
    const r = db.prepare("SELECT COUNT(*) c FROM orgs WHERE revenue_source = 'recalled'").get().c;
    console.log(dim(`\n  ${r} firms are currently priced off a recalled revenue figure that`));
    console.log(dim('  nobody has checked. Each one `vet` reads is a test that lands here.'));
    return;
  }
  let within = 0;
  for (const x of rows) {
    const off = ((x.f - x.r) / x.r) * 100;
    if (Math.abs(off) <= 50) within++;
    console.log(`  ${x.metric.padEnd(10)} ${String(x.name).slice(0, 26).padEnd(28)}`
      + `recalled ${String(x.r).padStart(12)}  found ${String(x.f).padStart(12)}  `
      + `${off >= 0 ? '+' : ''}${off.toFixed(0)}%`);
  }
  console.log(dim(`\n  ${within} of ${rows.length} within 50% of the found figure.`));
  console.log(dim('  An order of magnitude is what the money gate needs; a precise number is not.'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb();
  if (args.accuracy) { accuracy(db); db.close(); return; }
  const cfg = await loadConfig();
  const model = str(args.model) ?? cfg.runtime?.models?.default ?? 'claude-sonnet-5';

  const orgId = str(args.org);
  let orgs = orgId
    ? db.prepare('SELECT * FROM orgs WHERE id = ?').all(orgId)
    : db.prepare(`SELECT * FROM orgs
         WHERE ${args.redo ? '1=1' : "(revenue_est IS NULL OR revenue_source = 'recalled')"}
           AND COALESCE(kind,'') <> 'delivery_firm'
         ORDER BY (SELECT COUNT(*) FROM people p WHERE p.org_id = orgs.id) DESC`).all();
  // Never overwrite something that was actually retrieved.
  orgs = orgs.filter((o) => o.revenue_est === null || o.revenue_source === 'recalled' || args.redo);
  const limit = Number(args.limit ?? 0) || orgs.length;
  orgs = orgs.slice(0, limit);

  console.log(heading(`SIZE — ${orgs.length} firm(s) with no revenue on file, model ${model}`));
  if (!orgs.length) { console.log('Nothing unsized.'); db.close(); return; }
  if (args.dry) {
    for (const o of orgs.slice(0, 40)) console.log(`  ${String(o.name).slice(0, 44).padEnd(46)}${dim(o.id)}`);
    if (orgs.length > 40) console.log(dim(`  ...and ${orgs.length - 40} more`));
    db.close(); return;
  }

  const runId = startRun(db, 'size', { model });
  // Through recordSize, so the "found beats recalled" rule lives in one place
  // rather than being re-implemented by every caller that writes a number.
  const setBasis = db.prepare('UPDATE orgs SET revenue_basis = ? WHERE id = ?');
  let spent = 0; let known = 0; let unknown = 0;
  const jobs = Math.max(1, Number(args.jobs ?? 4) || 4);
  let next = 0;

  const worker = async () => {
    for (let i = next++; i < orgs.length; i = next++) {
      const o = orgs[i];
      const titles = db.prepare('SELECT title FROM people WHERE org_id = ? AND title IS NOT NULL LIMIT 12')
        .all(o.id).map((r) => `  - ${r.title}`).join('\n');
      const res = await complete(db, runId, {
        model, maxTokens: 2500, schema: SCHEMA, system: SYSTEM,
        messages: [{ role: 'user', content:
          `Organisation: ${o.name}\n`
          + `${o.domain ? `Domain: ${o.domain}\n` : ''}`
          + `${o.industry ? `Industry: ${o.industry}\n` : ''}`
          + `${o.hq ? `HQ: ${o.hq}\n` : ''}`
          + `${o.headcount_est ? `Headcount on file: ${o.headcount_est} (${o.headcount_source ?? 'unknown source'})\n` : ''}`
          + `${titles ? `\nJob titles of people known to work there:\n${titles}\n` : ''}` }],
      });
      spent += res.cost_usd ?? 0;
      const d = res.data ?? {};
      const amt = Number(d.amount_usd ?? 0);
      if (amt > 0 && d.basis !== 'unknown') {
        const w = recordSize(db, o.id, 'revenue', amt, { found: false });
        setBasis.run(d.basis, o.id);
        known++;
        if (w.deferred_to_found) {
          console.log(dim(`  ${'kept'.padStart(8)}  a found figure already exists for ${o.name}; recall stored beside it`));
          continue;
        }
        console.log(`  ${d.confidence === 'firm' ? bold(usd(amt).padStart(8)) : dim(usd(amt).padStart(8))}`
          + `  ${d.basis.padEnd(7)} ${String(o.name).slice(0, 34).padEnd(36)}${dim(String(d.why).slice(0, 60))}`);
      } else {
        unknown++;
        console.log(dim(`  ${'—'.padStart(8)}  unknown ${String(o.name).slice(0, 34)}`));
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));

  console.log(dim(`\n  ${known} sized, ${unknown} unknown · $${spent.toFixed(4)}`));
  console.log(dim('  Every figure here is RECALLED, not retrieved. revenue_source says so,'));
  console.log(dim('  and a gate reading one should say so too.'));
  finishRun(db, runId, { cost_usd: spent, n_in: orgs.length, n_out: known });
  db.close();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
