// One command for the day: find, vet, judge, and rebuild the Ready page.
//
// Each step is an existing stage, run in order, so this adds no logic of its
// own beyond deciding what each step should cover:
//
//   1. searches   the measured search list, --save, but only once a week (it
//                 costs a search credit per search, and the news does not turn
//                 over daily); --searches forces it
//   1b. agendas   speakers from conference agendas (`npm run events`), also
//                 weekly: a session abstract is a named practitioner saying what
//                 they are working on, which no news search reaches; --events
//                 forces it
//   2. vet        firms the searches added and nobody has vetted: resolve their
//                 website, then vet the ones that have one
//   3. rank       still needed: it supplies the order in which the judge meets
//                 people it has not seen
//   4. judge      the two likeliest people at each newly vetted firm, then the
//                 next people from the ranker's list, so the page never runs dry
//   5. dash       rebuild the pages
//
// Every stage records its own cost in `runs`; the summary at the end adds them
// up for this run. Nothing is sent to anyone.
//
// Usage:
//   npm run daily                 the day's run
//   npm run daily -- --searches   run the searches even if they ran this week
//   npm run daily -- --events     run the conference agendas even if they ran this week
//   npm run daily -- --judge N    how many from the ranker's list to judge (default 3)
//   npm run daily -- --dry        say what would run, run nothing

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { heading, bold, dim } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
// 3, not 10 (2026-09-28): the backlog, in the old ranker's order, now yields
// 1s and 2s (80 judged, no 4 or 5); new firms from searches and agendas are
// judged in full above this and are where the strong cards come from.
const judgeN = Number(args[args.indexOf('--judge') + 1]) || 3;
const started = new Date().toISOString();

const STEP_LIMIT_MS = 10 * 60_000;   // generous: a vet with a browser fallback takes a few minutes
const run = (label, cmd) => {
  console.log(`\n${bold(label)} ${dim(`npm run ${cmd.join(' ')}`)}`);
  if (dry) return '';
  try {
    // A TIME LIMIT PER STEP, added 2026-09-29: one firm's enrich sat idle for
    // over twenty minutes with no socket open and no child process, and the
    // whole run waited on it. A step that fails here is logged and the run
    // moves on, as any other failure does.
    const out = execFileSync('npm', ['run', '--silent', ...cmd], { cwd: ROOT, encoding: 'utf8',
      maxBuffer: 64 << 20, timeout: STEP_LIMIT_MS, killSignal: 'SIGKILL' });
    return out.replace(/\x1b\[[0-9;]*m/g, '');
  } catch (e) {
    console.log(`  FAILED: ${String(e.stderr || e.message).split('\n').filter((l) => !/warning/.test(l)).slice(-3).join(' ')}`);
    return '';
  }
};
const q = (sql, ...p) => { const db = openDb(); try { return db.prepare(sql).all(...p); } finally { db.close(); } };

// Local time in the header: the log's own "=== <date>" line is local, and a
// UTC header beside it read as a 7-hour stall that was not there.
const localStart = new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 16);
console.log(heading(`daily · ${localStart}${dry ? ' · dry run' : ''}`));

// 1. searches, weekly
const last = q(`SELECT MAX(run_at) t FROM search_runs`)[0]?.t;
const ageDays = last ? (Date.now() - Date.parse(last)) / 86_400_000 : Infinity;
let searched = false;
if (args.includes('--searches') || ageDays >= 6) {
  const out = run('1. searches', ['queries', '--', '--run', '--save']);
  searched = true;
  const m = out.match(/Ran (\d+) searches · (\d+) credits · (\d+) new finds/);
  if (m) console.log(`  ${m[1]} searches, ${m[3]} new finds`);
} else {
  console.log(`\n${bold('1. searches')} ${dim(`skipped: last run ${ageDays.toFixed(1)} days ago, weekly (--searches to force)`)}`);
}

// 1b. conference agendas, weekly. The stage loads speakers with their firm's
// kind already set, so rank and the judge's queue meet them without a vet.
const lastEv = q(`SELECT MAX(started_at) t FROM runs WHERE stage = 'events'`)[0]?.t;
const evAge = lastEv ? (Date.now() - Date.parse(lastEv)) / 86_400_000 : Infinity;
let agendas = false;
if (args.includes('--events') || evAge >= 6) {
  const out = run('1b. conference agendas', ['events']);
  agendas = true;
  const w = out.match(/wrote (\d+) people/); const f = out.match(/(\d+) of (\d+) sessions named a difficulty/);
  if (w || f) console.log(`  ${w ? `${w[1]} people` : ''}${f ? ` · ${f[1]} of ${f[2]} sessions named a difficulty` : ''}`);
} else {
  console.log(`\n${bold('1b. conference agendas')} ${dim(`skipped: last run ${evAge.toFixed(1)} days ago, weekly (--events to force)`)}`);
}

// 1c. conferences nobody configured (added 2026-09-30): find new ones weekly,
// read two waiting agendas every weekday so the list moves without anyone
// asking. Speakers arrive through the same path as 1b, so gate runs after.
const lastFind = q(`SELECT MAX(started_at) t FROM runs WHERE stage = 'conferences-find'`)[0]?.t;
const findAge = lastFind ? (Date.now() - Date.parse(lastFind)) / 86_400_000 : Infinity;
if (args.includes('--conferences') || findAge >= 6) {
  const out = run('1c. find conferences', ['conferences', '--', '--find']);
  const m = out.match(/(\d+) new conferences found/);
  if (m) console.log(`  ${m[1]} new conferences found`);
} else {
  console.log(`\n${bold('1c. find conferences')} ${dim(`skipped: last run ${findAge.toFixed(1)} days ago, weekly (--conferences to force)`)}`);
}
{
  const out = run('1c. read conference agendas', ['conferences', '--', '--read', '--limit', '2']);
  const w = out.match(/wrote (\d+) people/);
  if (w) { agendas = true; console.log(`  ${w[1]} people from new agendas`); }
}

// 2. vet what the searches added
const unvetted = () => q(`SELECT id, name, domain FROM orgs WHERE source LIKE 'intake search:%' AND kind IS NULL`);
// A website that could not be confirmed is retried for three days, not forever.
const recent = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
const noSite = q(`SELECT id, name FROM orgs WHERE source LIKE 'intake search:%' AND kind IS NULL
    AND (domain IS NULL OR TRIM(domain) = '') AND first_seen >= ?`, recent);
for (const o of noSite) run(`2. domain · ${o.name}`, ['lead', '--', 'domains', '--org', o.id]);
const vetted = [];
for (const o of unvetted().filter((x) => x.domain)) {
  const out = run(`2. vet · ${o.name}`, ['lead', '--', 'vet', '--id', o.id, '--name', o.name, '--domain', o.domain]);
  const verdict = out.match(/— ([A-Z ]{6,})/)?.[1]?.trim();
  if (verdict) console.log(`  ${verdict}`);
  vetted.push(o.id);
}

// 3. gate and rank. The gates cost nothing (no model call) and a week's
// agenda speakers arrive ungated; firms the vet step saw were gated there.
if (agendas) run('3. gate', ['gate']);
run('3. rank', ['rank']);

// 4. judge: two per newly vetted firm that survived, then the ranker's next
const alive = vetted.length ? q(`SELECT id FROM orgs WHERE id IN (${vetted.map(() => '?').join(',')})
    AND kind IS NOT NULL AND id NOT IN (SELECT org_id FROM gate_results WHERE outcome LIKE 'kill%')`, ...vetted).map((r) => r.id) : [];
const top2 = alive.length ? q(`WITH latest AS (SELECT * FROM person_scores s
      WHERE id = (SELECT MAX(id) FROM person_scores x WHERE x.person_id = s.person_id))
    SELECT person_id FROM (SELECT person_id, ROW_NUMBER() OVER (PARTITION BY org_id ORDER BY total DESC) rn
      FROM latest WHERE org_id IN (${alive.map(() => '?').join(',')}))
    WHERE rn <= 2 AND person_id NOT IN (SELECT person_id FROM judgments)`, ...alive).map((r) => r.person_id) : [];
for (const p of top2) run(`4. judge · ${p}`, ['judge', '--', '--person', p]);
run(`4. judge · next ${judgeN} from the ranker's list`, ['judge', '--', '--queue', '--limit', String(judgeN)]);

// 5. pages
run('5. dash', ['dash']);

// summary
if (!dry) {
  const cost = q(`SELECT ROUND(SUM(cost_usd), 3) c, SUM(tavily_credits) t FROM runs WHERE started_at >= ?`, started)[0];
  const judged = q(`SELECT COUNT(DISTINCT person_id) n FROM judgments WHERE created_at >= ?`, started)[0].n;
  // The page's own count: it already knows who is live, uncontacted and undecided.
  let waiting = '?';
  try { waiting = readFileSync(resolve(ROOT, 'data/dash/ready.html'), 'utf8').match(/(\d+) to decide/)?.[1] ?? '0'; } catch { /* no page yet */ }
  console.log(heading('done'));
  console.log(`  searches ${searched ? 'ran' : 'skipped'} · agendas ${agendas ? 'ran' : 'skipped'} · ${vetted.length} firm(s) vetted, ${alive.length} alive · `
    + `${judged} judged · $${cost.c ?? 0} model cost · ${cost.t ?? 0} search credits`);
  console.log(`  ${waiting} people waiting on the Ready page`);
  console.log(dim('  open http://127.0.0.1:8787/ready.html'));
}
