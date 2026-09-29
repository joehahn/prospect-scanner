// Stage 10: read every drafted note at once and count what is wrong with them.
//
// THE OPERATOR, 2026-09-24: "this problem is taking way too long to solve, what
// are we doing wrong, and how can we fix this faster? should we do a debugging
// loop to iterate across prompt tweaks and code changes until draft note is
// close enough to want to send?"
//
// What was wrong is that every prompt change tonight was validated on the ONE
// note that prompted it. Eleven versions of draft-cold-note, each checked
// against a single draft, and no way to know whether a change helped the other
// fifteen or broke them. One note per cycle is why it was slow.
//
// This is the geo-herd-rider loop, which that project states plainly: "a
// 12-scan slice opens ~109 events... this renders the same events as a few
// hundred lines of text, so a whole slice can be read in one pass and the same
// event RE-READ NEXT ITERATION to see whether a named defect closed."
//
// So: the drafts already on file are the corpus. Each flag encodes a failure
// actually hit here. Change a prompt, re-draft, re-run, compare the census.
// Judging costs about three cents a note, which is a fifth of drafting one, so
// an iteration over everything is under a dollar and takes two minutes.
//
// IT JUDGES, IT NEVER REWRITES. A checker that fixes what it finds cannot be
// used to measure whether the fix upstream worked.
//
// Usage:
//   npm run audit                    every current draft not yet sent
//   npm run audit -- --person <id>
//   npm run audit -- --census        just the flag counts, for comparing runs

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { complete } from './models.mjs';
import { heading, bold, dim } from './report.mjs';
import { checkNote, MECHANICAL_FLAGS } from './checks.mjs';
import { statSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = 'prompts/audit-note.md';

const FLAGS = ['offers-a-meeting', 'dropped-the-object', 'generic', 'recites',
  'speculative-detail', 'unsourced-claim', 'wrong-register', 'formulaic'];

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'flags'],
  properties: {
    verdict: { type: 'string', enum: ['send', 'fix'] },
    flags: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['flag', 'quote', 'why'],
        properties: {
          flag: { type: 'string', enum: FLAGS },
          quote: { type: 'string', description: 'The words from the note, verbatim.' },
          why: { type: 'string' },
        },
      },
    },
  },
};

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]; if (!t.startsWith('--')) continue;
    const k = t.slice(2); const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) a[k] = true; else { a[k] = n; i++; }
  }
  return a;
}
const noteOnly = (b) => {
  const cut = String(b ?? '').split(/^NOTES\s*$/m)[0].replace(/^\s*DRAFT\s*\n-+\s*\n/m, '').trim();
  return cut.length > 40 ? cut : '';
};

/**
 * This run against the one before it. The whole reason findings are stored.
 *
 * MECHANICAL AND JUDGE COUNTS ARE NOT COMPARED THE SAME WAY, and pooling them
 * would be the error this project keeps making in other forms. A mechanical
 * count is arithmetic: if it moved, something changed. A judge count is a
 * sample: re-running the judge over an UNCHANGED corpus moved a flag by three,
 * so a judge delta inside that band is noise wearing a number.
 */
function compare(db, runId) {
  const prev = db.prepare(
    'SELECT DISTINCT run_id FROM audit_findings WHERE run_id < ? ORDER BY run_id DESC LIMIT 1')
    .get(runId)?.run_id;
  if (!prev) {
    console.log(dim('\n  First stored run. Change one thing, run this again, and the'));
    console.log(dim('  next census will be a comparison rather than a number.'));
    return;
  }
  const counts = (rid) => Object.fromEntries(db.prepare(
    'SELECT flag, source, COUNT(*) n FROM audit_findings WHERE run_id = ? GROUP BY flag, source')
    .all(rid).map((r) => [`${r.source}/${r.flag}`, r.n]));
  const a = counts(prev);
  const b = counts(runId);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  console.log(heading(`AGAINST RUN ${prev}`));
  let moved = 0;
  for (const k of keys) {
    const was = a[k] ?? 0;
    const now = b[k] ?? 0;
    if (was === now) continue;
    moved++;
    const d = now - was;
    const judge = k.startsWith('judge/');
    const noisy = judge && Math.abs(d) <= 3;
    const arrow = d < 0 ? 'better' : 'WORSE ';
    console.log(`  ${noisy ? dim(arrow) : bold(arrow)} ${k.padEnd(28)} ${was} -> ${now}`
      + (noisy ? dim('   within judge noise, re-run before believing it') : ''));
  }
  if (!moved) console.log(dim('  nothing moved'));
  const pf = db.prepare('SELECT DISTINCT prompt_mtime FROM audit_findings WHERE run_id = ?');
  const pa = pf.get(prev)?.prompt_mtime ?? '?';
  const pb = pf.get(runId)?.prompt_mtime ?? '?';
  console.log(dim(`\n  draft prompt: ${pa === pb ? 'UNCHANGED between runs' : `${pa} -> ${pb}`}`));
  if (pa === pb) {
    console.log(dim('  With the prompt unchanged, a mechanical move means the DRAFTS changed;'));
    console.log(dim('  a judge move means the judge did.'));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb();
  const cfg = await loadConfig();
  const model = (args.model && args.model !== true) ? String(args.model)
    : (cfg.models?.draft ?? cfg.models?.default);   // from runtime.yml; complete() refuses none

  const rows = db.prepare(`
    SELECT d.id, d.person_id, d.body, d.package_id, p.name, p.title,
           COALESCE(o.name,'') org, COALESCE(o.headcount_est,0) hc,
           COALESCE(o.revenue_est,0) rev
      FROM drafts d JOIN people p ON p.id = d.person_id
      LEFT JOIN orgs o ON o.id = p.org_id
     WHERE d.id IN (SELECT MAX(id) FROM drafts GROUP BY person_id)
       AND d.sent_text IS NULL
       ${args.person && args.person !== true ? 'AND d.person_id = ?' : ''}`)
    .all(...(args.person && args.person !== true ? [String(args.person)] : []))
    .map((r) => ({ ...r, note: noteOnly(r.body) }))
    .filter((r) => r.note);

  console.log(heading(`AUDIT — ${rows.length} current draft(s), model ${model}`));
  if (!rows.length) { console.log('No drafts to read.'); db.close(); return; }

  const runId = startRun(db, 'audit', { model });

  // THE FREE PASS FIRST. These are arithmetic over the text: the same answer
  // every time, no model, no cost, and they cover most of the defects found by
  // hand this week. Running them over the whole corpus takes about a second, so
  // there is no reason to pay a judge three cents a note to settle something a
  // regular expression can.
  const DRAFT_PROMPT = 'prompts/draft-cold-note.md';
  let promptMtime = '';
  try { promptMtime = statSync(resolve(ROOT, DRAFT_PROMPT)).mtime.toISOString(); } catch { /* fine */ }
  const record = db.prepare('INSERT INTO audit_findings (run_id, draft_id, person_id, flag, source, detail, draft_prompt, prompt_mtime, created_at) VALUES (@run, @draft, @person, @flag, @source, @detail, @pf, @mt, @now)');
  const stamp = new Date().toISOString();
  const save = (r, f, source) => record.run({ run: runId, draft: r.id ?? null,
    person: r.person_id ?? null, flag: f.flag, source, detail: f.detail ?? null,
    pf: DRAFT_PROMPT, mt: promptMtime, now: stamp });

  const mech = Object.fromEntries(MECHANICAL_FLAGS.map((f) => [f, 0]));
  for (const r of rows) {
    const evidenceText = db.prepare(
      'SELECT claim, body FROM evidence WHERE person_id = ? OR (org_id = ? AND person_id IS NULL)')
      .all(r.person_id, r.org_id).map((e) => (e.claim ?? '') + ' ' + (e.body ?? '')).join(' ');
    const hasRead = !!db.prepare(
      'SELECT 1 FROM reads WHERE person_id = ? AND rejected_at IS NULL LIMIT 1').get(r.person_id);
    for (const f of checkNote({ raw: r.body, person: { name: r.name },
      org: { name: r.org_name }, evidenceText, hasRead })) {
      mech[f.flag] = (mech[f.flag] ?? 0) + 1;
      save(r, f, 'mechanical');
    }
  }
  console.log(heading('MECHANICAL — ' + rows.length + ' notes, no model, $0.00'));
  for (const [f, n] of Object.entries(mech).sort((a, b) => b[1] - a[1])) {
    if (n) console.log('  ' + String(n).padStart(4) + '  ' + f
      + '  ' + dim(Math.round(100 * n / rows.length) + '%'));
  }
  if (!Object.values(mech).some(Boolean)) console.log(dim('  nothing flagged'));

  if (args.mechanical) {
    console.log(dim('\n  ' + rows.length + ' notes checked, nothing spent. Run ' + runId + '.'));
    finishRun(db, runId, { cost_usd: 0, n_in: rows.length, n_out: rows.length });
    compare(db, runId);
    db.close();
    return;
  }

  const prompt = readFileSync(resolve(ROOT, PROMPT_FILE), 'utf8');
  // The other notes go in so `formulaic` has something to compare against. A
  // repeated phrase is invisible one note at a time and obvious across a batch,
  // which is the whole reason this reads them together.
  const others = rows.map((r) => noteOnly(r.body).split('\n').filter(Boolean).slice(0, 2).join(' ')).join('\n');

  const census = Object.fromEntries(FLAGS.map((f) => [f, 0]));
  let spent = 0; let fix = 0;
  const jobs = Math.max(1, Number(args.jobs ?? 5) || 5);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < rows.length; i = next++) {
      const r = rows[i];
      const read = db.prepare(`SELECT trying_to_do, in_the_way, what_an_hour_does, do_not_say
          FROM reads WHERE person_id = ? AND rejected_at IS NULL ORDER BY id DESC LIMIT 1`).get(r.person_id);
      const ev = db.prepare(`SELECT claim FROM evidence WHERE person_id = ? OR org_id =
          (SELECT org_id FROM people WHERE id = ?) LIMIT 30`).all(r.person_id, r.person_id)
        .map((e) => `- ${e.claim}`).join('\n');
      const res = await complete(db, runId, {
        model, maxTokens: 6000, schema: SCHEMA, system: prompt,
        messages: [{ role: 'user', content:
          `## The note\n\n${r.note}\n\n`
          + `## Who it is going to\n${r.name} — ${r.title ?? '?'}, ${r.org}`
          + `${r.hc ? `, about ${r.hc} people` : ''}${r.rev ? `, ~$${Math.round(r.rev / 1e6)}m` : ''}\n`
          + `Offer pitched: ${r.package_id ?? '(none)'}\n\n`
          + `## The read it was built from\n${read
            ? `TRYING TO DO: ${read.trying_to_do}\nAN HOUR DOES: ${read.what_an_hour_does}\n`
              + `DO NOT SAY: ${read.do_not_say}` : '(no read on file)'}\n\n`
          + `## Evidence on file\n${ev || '(none)'}\n\n`
          + `## Openings and closings of the other notes in this batch\n${others}` }],
      });
      spent += res.cost_usd ?? 0;
      const d = res.data ?? {};
      if (d.verdict === 'fix') fix++;
      for (const f of d.flags ?? []) {
        census[f.flag] = (census[f.flag] ?? 0) + 1;
        save(r, { flag: f.flag, detail: String(f.quote ?? '').slice(0, 200) }, 'judge');
      }
      if (!args.census) {
        const tag = d.verdict === 'send' ? dim('send') : bold('FIX ');
        console.log(`  ${tag} ${String(r.name).padEnd(20)} ${(d.flags ?? []).map((f) => f.flag).join(', ') || dim('clean')}`);
        for (const f of d.flags ?? []) console.log(dim(`         ${f.flag}: "${String(f.quote).slice(0, 88)}"`));
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));

  console.log(heading('CENSUS'));
  // A SINGLE RUN IS NOT A MEASUREMENT, and this stage was built as though it
  // were. Re-running it over an UNCHANGED set of notes moved `generic` from 4
  // to 7 and `offers-a-meeting` from 0 to 3 — run-to-run noise the same size as
  // the prompt effects being chased. Three conclusions were drawn from single
  // runs before anyone checked.
  //
  // So the census is A PLACE TO LOOK, never a defect count. Compare runs only
  // where a flag moves by more than a few, and re-run before believing it.
  for (const [f, n] of Object.entries(census).sort((a, b) => b[1] - a[1])) {
    if (n) console.log(`  ${String(n).padStart(3)}  ${f}`);
  }
  console.log(`\n  ${rows.length - fix} of ${rows.length} would send · $${spent.toFixed(4)}`);
  console.log(dim('\n  A SINGLE RUN IS NOT A MEASUREMENT. Re-running this over unchanged notes has'));
  console.log(dim('  moved a flag by 3. Treat the census as a place to look; re-run before'));
  console.log(dim('  believing a difference, and distrust anything smaller than a few.'));
  finishRun(db, runId, { cost_usd: spent, n_in: rows.length, n_out: rows.length - fix });
  compare(db, runId);
  db.close();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
