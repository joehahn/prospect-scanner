// Stage 11: regenerate a fixed panel of notes and measure what changed.
//
// THE OPERATOR, 2026-09-25: "i'm sensing that the drafter still has several or
// maybe many shortcomings that will take forever to debug serially, what is the
// best way to debug that so that a suite of drafts systematically get better?"
// And, shown two redrafted notes a moment later: "is the above resolving the
// debugging issue? or merely redrafting notes?" It was merely redrafting.
//
// `audit` counts defects across the drafts that happen to exist. That is a
// census, not an experiment, and it cannot attribute a change to anything: the
// corpus moves under you between runs, and most of it is notes nobody will send.
//
// This is the experiment. One command:
//   1. re-read and re-draft every panel member, so the notes reflect the CURRENT
//      prompts and code rather than whatever produced them last week;
//   2. run the free mechanical census over exactly those notes;
//   3. diff it against the previous bench run.
//
// Change ONE thing, run this, read the delta. About $2 a cycle at present
// prices, most of it the drafting.
//
// WHY A FIXED PANEL AND NOT "ALL SENDABLE DRAFTS": the sendable set changes as
// firms are contacted and gates fire, so two runs a day apart are not comparable.
// The panel only changes when you change it, deliberately.
//
// Usage:
//   npm run bench -- --init      propose a panel spanning the situations
//   npm run bench                regenerate the panel and compare
//   npm run bench -- --show      who is on it and why
//   npm run bench -- --dry       what it would redraft, and the cost

import { openDb, startRun, finishRun } from './db.mjs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNote, MECHANICAL_FLAGS } from './checks.mjs';
import { heading, bold, dim } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const k = t.slice(2); const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) a[k] = true; else { a[k] = n; i++; }
  }
  return a;
}

/**
 * Candidates for the panel: sendable, and spanning the situations.
 *
 * ONE PER FIRM AND ONE PER TRIGGER SHAPE. A panel with four seats at one
 * chipmaker on it measures one firm four times and tells you nothing about the
 * fourth situation you never covered.
 */
function propose(db) {
  const rows = db.prepare(`
    SELECT p.id, p.name, o.name AS org, o.id AS org_id,
           (SELECT GROUP_CONCAT(DISTINCT s.trigger_id) FROM signals s
             WHERE s.org_id = p.org_id AND s.retracted_at IS NULL) AS triggers,
           (SELECT COUNT(*) FROM evidence e WHERE e.person_id = p.id
             AND e.provenance = 'operator_supplied') AS pasted,
           (SELECT MAX(total) FROM person_scores ps WHERE ps.person_id = p.id) AS score
      FROM people p JOIN orgs o ON o.id = p.org_id
     WHERE NOT EXISTS (SELECT 1 FROM gate_results g
                        WHERE g.org_id = p.org_id AND g.outcome LIKE 'kill%')
       AND NOT EXISTS (SELECT 1 FROM outreach ou JOIN people q ON q.id = ou.person_id
                        WHERE q.org_id = p.org_id)
       AND NOT EXISTS (SELECT 1 FROM do_not_contact d
                        WHERE d.person_id = p.id OR d.org_id = p.org_id)
       AND EXISTS (SELECT 1 FROM person_scores ps
                    WHERE ps.person_id = p.id AND ps.persona_authority IN ('buyer','router'))
     ORDER BY score DESC`).all();

  const picked = [];
  const firms = new Set();
  const shapes = new Set();
  for (const r of rows) {
    if (firms.has(r.org_id)) continue;
    // The situation this member covers: its strongest trigger, or the absence
    // of one, which is its own situation and the hardest to write against.
    const shape = (r.triggers ?? '').split(',')[0] || (r.pasted ? 'pasted-profile-only' : 'thin');
    if (shapes.has(shape) && picked.length >= 8) continue;
    firms.add(r.org_id); shapes.add(shape);
    picked.push({ ...r, shape });
    if (picked.length >= 12) break;
  }
  return picked;
}

function show(db) {
  const rows = db.prepare(`SELECT b.person_id, b.why, p.name, o.name AS org
      FROM bench b JOIN people p ON p.id = b.person_id JOIN orgs o ON o.id = p.org_id
     ORDER BY p.name`).all();
  if (!rows.length) { console.log('No panel yet. Run `npm run bench -- --init`.'); return; }
  console.log(heading(`PANEL — ${rows.length}`));
  for (const r of rows) console.log(`  ${String(r.name).padEnd(22)} ${String(r.org).padEnd(26)} ${dim(r.why ?? '')}`);
}

/** The mechanical census over exactly the panel's current notes. */
function census(db, panel) {
  const counts = Object.fromEntries(MECHANICAL_FLAGS.map((f) => [f, 0]));
  const perPerson = [];
  for (const id of panel) {
    const d = db.prepare(`SELECT d.id, d.body, p.name, o.name AS org_name, p.org_id
        FROM drafts d JOIN people p ON p.id = d.person_id JOIN orgs o ON o.id = p.org_id
       WHERE d.person_id = ? ORDER BY d.id DESC LIMIT 1`).get(id);
    if (!d) { perPerson.push({ id, name: id, draft_id: null, flags: [], missing: true }); continue; }
    const evidenceText = db.prepare(
      'SELECT claim, body FROM evidence WHERE person_id = ? OR (org_id = ? AND person_id IS NULL)')
      .all(id, d.org_id).map((e) => `${e.claim ?? ''} ${e.body ?? ''}`).join(' ');
    const hasRead = !!db.prepare(
      'SELECT 1 FROM reads WHERE person_id = ? AND rejected_at IS NULL LIMIT 1').get(id);
    const flags = checkNote({ raw: d.body, person: { name: d.name },
      org: { name: d.org_name }, evidenceText, hasRead });
    for (const f of flags) counts[f.flag] = (counts[f.flag] ?? 0) + 1;
    perPerson.push({ id, name: d.name, draft_id: d.id, flags });
  }
  // HOW MANY NOTES THIS CENSUS ACTUALLY SAW. A panel member with no draft yet
  // contributes no flags, which is indistinguishable from a clean note unless
  // the denominator is carried alongside the counts.
  return { counts, perPerson, n: perPerson.filter((x) => !x.missing).length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb();

  if (args.show) { show(db); db.close(); return; }

  if (args.init) {
    const picked = propose(db);
    const ins = db.prepare('INSERT OR REPLACE INTO bench (person_id, why, added_at) VALUES (?,?,?)');
    const today = new Date().toISOString().slice(0, 10);
    for (const p of picked) ins.run(p.id, `${p.shape} · ${p.org}`, today);
    console.log(heading(`PANEL SET — ${picked.length}`));
    for (const p of picked) {
      console.log(`  ${String(p.name).padEnd(22)} ${String(p.org).padEnd(26)} ${dim(p.shape)}`);
    }
    console.log(dim('\n  These are the people every cycle re-drafts. Edit the bench table to change it.'));
    db.close(); return;
  }

  const panel = db.prepare('SELECT person_id FROM bench').all().map((r) => r.person_id);
  if (!panel.length) { console.log('No panel. Run `npm run bench -- --init` first.'); db.close(); return; }

  if (args.dry) {
    console.log(heading(`WOULD REGENERATE ${panel.length}`));
    console.log(dim(`  about $${(panel.length * 0.163).toFixed(2)} — $0.034 read + $0.129 draft each`));
    db.close(); return;
  }

  // BEFORE, so the comparison is against this machine's own previous state and
  // not against a census someone ran over a different corpus last week.
  const before = census(db, panel);

  const runId = startRun(db, 'bench', { notes: `panel of ${panel.length}` });
  console.log(heading(`BENCH — regenerating ${panel.length} notes`));
  let failed = 0;
  for (const id of panel) {
    // REJECT THE OLD READ RATHER THAN KEEPING IT. The read is upstream of the
    // draft and is exactly the thing a prompt change is meant to move, so a
    // cycle that reuses yesterday's thesis measures half the system.
    db.prepare("UPDATE reads SET rejected_at = date('now'), rejected_reason = 'bench cycle' "
      + 'WHERE person_id = ? AND rejected_at IS NULL').run(id);
    for (const [stage, extra] of [['read', ['--redo']], ['draft', ['--force']]]) {
      try {
        execFileSync('npm', ['run', stage, '--silent', '--', '--person', id, ...extra],
          { cwd: ROOT, encoding: 'utf8' });
      } catch (e) {
        // exit 2 is a verdict about the note, not a crash: the draft exists.
        if (e.status !== 2) { failed++; console.log(dim(`  ${id}: ${stage} failed (${e.status})`)); }
      }
    }
    process.stdout.write('.');
  }
  console.log('');

  const after = census(db, panel);
  const spent = db.prepare(
    "SELECT ROUND(SUM(cost_usd),4) c FROM runs WHERE id > ? AND stage IN ('read','draft')")
    .get(runId)?.c ?? 0;

  // A COMPARISON NEEDS SOMETHING TO COMPARE TO. On the first cycle, 9 of 12
  // panel members had never been drafted at all, so every flag started at zero
  // and the run reported its own first measurement as WORSE across the board.
  // A baseline that saw a different number of notes is not a baseline.
  const comparable = before.n === after.n && before.n > 0;
  console.log(heading(`CENSUS — ${after.n} note(s) of ${panel.length}`));
  const keys = MECHANICAL_FLAGS.filter((f) => before.counts[f] || after.counts[f]);
  if (!comparable) {
    console.log(dim(`  No comparison: the run before this one saw ${before.n} note(s), this one `
      + `${after.n}. Reporting counts only.`));
    if (!keys.length) console.log(dim('  clean'));
    for (const f of keys) {
      console.log(`  ${String(after.counts[f] ?? 0).padStart(4)}  ${f}`);
    }
  } else {
    if (!keys.length) console.log(dim('  clean, before and after'));
    for (const f of keys) {
      const was = before.counts[f] ?? 0;
      const now = after.counts[f] ?? 0;
      const d = now - was;
      const tag = d === 0 ? dim('  same') : d < 0 ? bold(' better') : bold(' WORSE');
      console.log(`  ${tag}  ${f.padEnd(20)} ${was} -> ${now}`);
    }
  }
  for (const p of after.perPerson.filter((x) => x.missing)) {
    console.log(dim(`    ${String(p.id).padEnd(22)} no draft produced`));
  }
  for (const p of after.perPerson.filter((x) => x.flags.length)) {
    console.log(dim(`    ${String(p.name).padEnd(22)} ${p.flags.map((f) => f.flag).join(', ')}`));
  }
  console.log(dim(`\n  $${Number(spent).toFixed(2)} spent${failed ? `, ${failed} stage failure(s)` : ''}`));
  console.log(dim('  These counts are arithmetic, not a judge: a move is real, not noise.'));
  console.log(dim('  For the defects arithmetic cannot see — generic, recites, formulaic —'));
  console.log(dim('  run `npm run audit`, and run it twice before believing a move.'));
  finishRun(db, runId, { cost_usd: Number(spent) || 0, n_in: panel.length, n_out: panel.length - failed });
  db.close();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
