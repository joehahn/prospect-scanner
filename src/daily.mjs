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
//   4. screen     one pass on the cheap model over people never judged, up to
//                 --screen (new people first), so the full judge's three runs go
//                 to the ones worth it
//   4. judge      in full, the best screened people, up to --judge
//   4a. bios      official bios, from the organisation's own site or a conference
//                 site, for the people the Ready page would ask to paste; anyone
//                 found is judged again on the bio
//   4b. draft     a first draft for the top --drafts people the judge rated 3+,
//                 one per firm, so the morning starts with notes to edit, not
//                 cards to draft from. Email where an address is confirmed,
//                 otherwise a LinkedIn connection note. Nothing is sent.
//   4c. grade     those drafts, by a model other than the drafter; a failing
//                 one is flagged on its card with the words that failed
//   5. dash       rebuild the pages
//
// Every stage records its own cost in `runs`; the summary at the end adds them
// up for this run. Nothing is sent to anyone.
//
// Usage:
//   npm run daily                 the day's run
//   npm run daily -- --searches   run the searches even if they ran this week
//   npm run daily -- --events     run the conference agendas even if they ran this week
//   npm run daily -- --screen N   how many people to screen (default 600)
//   npm run daily -- --judge N    how many screened people to judge in full (default 150)
//   npm run daily -- --bios N     how many paste-list people to look up a bio for (default 20)
//   npm run daily -- --drafts N   how many first drafts to write (default 10)
//   npm run daily -- --no-batch   send every model call directly, at full price
//   npm run daily -- --dry        say what would run, run nothing

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { strongWritable, pasteQueue } from './funnel.mjs';
import { heading, bold, dim } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
// 150, not 3 (2026-10-01): the operator's goal is about 100 strong prospects
// and about 10 strong notes a day, and judging three a day was the narrowest
// point in the whole pipeline (390 of ~4,000 people ever judged). New people
// are judged first, because the backlog in the old ranker's order rates 1-2;
// the ranker's list only fills what is left.
const argN = (flag, dflt) => { const i = args.indexOf(flag); const n = i >= 0 ? Number(args[i + 1]) : NaN; return Number.isFinite(n) && n >= 0 ? n : dflt; };
const judgeN = argN('--judge', 150);
// THE SCREEN, added 2026-10-02 (judge.mjs --screen). Measured on 80 people the
// full judge had rated: passing those the screen rates 2+ kept all 10 the judge
// rated 3+ and sent 52 of 80 on, at $0.006 a person against $0.036. Small n; the
// threshold is re-checked with `npm run judge -- --screen --eval`.
const screenN = argN('--screen', 600);
const SCREEN_PASS = 2;
// HALF PRICE ON THE STEPS NOBODY WATCHES (2026-10-02): screening, judging and
// grading go through the Batches API (models.mjs). One step each, so each is
// one batch; the time limit covers the batch's own 40-minute deadline plus the
// direct calls it falls back to. --no-batch sends them the ordinary way.
const BATCH = args.includes('--no-batch') ? null
  : { env: { CLAUDE_BATCH: '1', CLAUDE_BATCH_WAIT_MIN: '40' }, limitMs: 75 * 60_000 };
const draftN = argN('--drafts', 10);
const started = new Date().toISOString();

const STEP_LIMIT_MS = 10 * 60_000;   // generous: a vet with a browser fallback takes a few minutes
const run = (label, cmd, { env = {}, limitMs = STEP_LIMIT_MS } = {}) => {
  console.log(`\n${bold(label)} ${dim(`npm run ${cmd.join(' ')}`)}`);
  if (dry) return '';
  try {
    // A TIME LIMIT PER STEP, added 2026-09-29: one firm's enrich sat idle for
    // over twenty minutes with no socket open and no child process, and the
    // whole run waited on it. A step that fails here is logged and the run
    // moves on, as any other failure does.
    const out = execFileSync('npm', ['run', '--silent', ...cmd], { cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, ...env }, maxBuffer: 64 << 20, timeout: limitMs, killSignal: 'SIGKILL' });
    return out.replace(/\x1b\[[0-9;]*m/g, '');
  } catch (e) {
    console.log(`  FAILED: ${String(e.stderr || e.message).split('\n').filter((l) => !/warning/.test(l)).slice(-3).join(' ')}`);
    return '';
  }
};
const q = (sql, ...p) => { const db = openDb(); try { return db.prepare(sql).all(...p); } finally { db.close(); } };

const runAsync = (label, cmd) => {
  console.log(`\n${bold(label)} ${dim(`npm run ${cmd.join(' ')}`)}`);
  if (dry) return Promise.resolve('');
  return new Promise((done) => execFile('npm', ['run', '--silent', ...cmd], { cwd: ROOT, encoding: 'utf8',
    maxBuffer: 64 << 20, timeout: STEP_LIMIT_MS, killSignal: 'SIGKILL' }, (e, out, err) => {
    // EXIT 2 IS A VERDICT, NOT A CRASH. draft exits 2 when the note was written
    // and stored but tripped one of its own checks; logging that as FAILED hid
    // eight stored drafts on 2026-10-02 and threw away which check fired. Name
    // the checks instead: they are the all-caps headings draft prints.
    if (e?.code === 2) {
      const flags = [...new Set(String(out).replace(/\x1b\[[0-9;]*m/g, '').split('\n')
        .map((l) => l.trim()).filter((l) => /^[A-Z][A-Z_ ]{4,}( —|$)/.test(l) && !/^(DRAFT|NOTES|SUBJECT)$/.test(l))
        .map((l) => l.split(' — ')[0]))];
      console.log(`  FLAGGED ${label}: stored, but ${flags.join(', ') || 'a check fired'}`);
      return done(String(out));
    }
    if (e) console.log(`  FAILED ${label}: ${String(err || e.message).split('\n').filter((l) => !/warning/.test(l)).slice(-2).join(' ')}`);
    done(e ? '' : String(out));
  }));
};

/**
 * Who gets a first draft this morning: the judge's 3+ ratings who are writable
 * (funnel.mjs) and have a pasted profile, nobody drafted in the last 14 days,
 * one per firm. Ordered as the Ready page orders: rating, then value, then how
 * soon the trigger is.
 */
function draftPicks(n) {
  // WRITABLE IS DEFINED ONCE, in funnel.mjs, so the paste list and the picks
  // cannot drift apart. A DRAFT WAITS FOR A PASTED PROFILE (2026-10-02): the
  // profile is where a note's substance comes from, and drafting without it
  // wrote three notes that morning that the profiles pasted an hour later
  // overturned. Those without one go on the paste list instead.
  const db = openDb();
  let people;
  try {
    const recentDraft = new Set(db.prepare(`SELECT person_id FROM drafts WHERE created_at >= datetime('now', '-14 days')
        AND person_id IS NOT NULL`).all().map((r) => r.person_id));
    people = strongWritable(db).filter((p) => p.has_profile && !recentDraft.has(p.person_id));
  } finally { db.close(); }
  // ONE FIRM CAN BE ON FILE TWICE: speaker harvests name a firm as the agenda
  // prints it, so "Acme" and "Acme Holdings" are two orgs, and a firm written
  // to this morning under one name came up for a draft under the other. Names
  // are compared without their legal endings.
  const firmKey = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(holdings?|group|inc|incorporated|corp|corporation|co|company|llc|ltd|limited|plc|the)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const orgName = new Map(q('SELECT id, name FROM orgs').map((o) => [o.id, o.name]));
  const recent = new Set(q(`SELECT DISTINCT org_id FROM outreach WHERE sent_at >= date('now', '-14 days')`)
    .map((r) => firmKey(orgName.get(r.org_id))));
  const firms = new Set();
  const picks = [];
  for (const p of people) {
    const key = firmKey(orgName.get(p.org_id));
    if (firms.has(p.org_id) || recent.has(key) || firms.has(key)) continue;
    firms.add(key);
    firms.add(p.org_id);
    // A confirmed address is the only reason to email; a guess bounces silently.
    // A 1st-degree connection gets a message, not a request to connect to
    // someone already connected (2026-10-05: two were about to).
    picks.push({ ...p, channel: p.email ? 'email' : Number(p.degree) === 1 ? 'dm' : 'connect' });
    if (picks.length >= n) break;
  }
  return picks;
}

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
// DAILY since 2026-10-02 (it was weekly): new people arrived in bursts --
// 160, 99, then 12, 15, 13 a day -- and the goal is a daily one. Eight search
// credits and about fifteen cents a run.
if (args.includes('--conferences') || findAge >= 0.5) {
  const out = run('1c. find conferences', ['conferences', '--', '--find']);
  const m = out.match(/(\d+) new conferences found/);
  if (m) console.log(`  ${m[1]} new conferences found`);
} else {
  console.log(`\n${bold('1c. find conferences')} ${dim(`skipped: last run ${findAge.toFixed(1)} days ago, daily (--conferences to force)`)}`);
}
{
  const out = run('1c. read conference agendas', ['conferences', '--', '--read', '--limit', '4']);
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

const alive = vetted.length ? q(`SELECT id FROM orgs WHERE id IN (${vetted.map(() => '?').join(',')})
    AND kind IS NOT NULL AND id NOT IN (SELECT org_id FROM gate_results WHERE outcome LIKE 'kill%')`, ...vetted).map((r) => r.id) : [];

// 4. screen, then judge. Every person not yet judged or screened gets one cheap
// pass, new people first (the window a trigger is newest), in steps of 150 so
// no step nears the time limit; the full judge then takes the best screened.
if (BATCH) {
  if (screenN > 0) run(`4. screen · up to ${screenN}, one batch`, ['judge', '--', '--screen', '--backlog', '--limit', String(screenN)], BATCH);
  if (judgeN > 0) run(`4. judge · screened ${SCREEN_PASS}+, up to ${judgeN}, one batch`,
    ['judge', '--', '--passed', '--min', String(SCREEN_PASS), '--limit', String(judgeN)], BATCH);
} else {
  for (let done = 0; done < screenN; done += 150) {
    const n = Math.min(150, screenN - done);
    const out = run(`4. screen · ${done + n} of up to ${screenN}`, ['judge', '--', '--screen', '--backlog', '--limit', String(n)]);
    if (/screened 0\b/.test(out)) break;
  }
  for (let done = 0; done < judgeN; done += 40) {
    const n = Math.min(40, judgeN - done);
    const out = run(`4. judge · screened ${SCREEN_PASS}+, ${done + n} of up to ${judgeN}`,
      ['judge', '--', '--passed', '--min', String(SCREEN_PASS), '--limit', String(n)]);
    if (/judge · 0 person/.test(out)) break;
  }
}

// 4a. official bios for the people the Ready page would ask to paste (bio.mjs):
// their organisation's own site or a conference site, never LinkedIn. Anyone a
// bio is found for is judged again on it before the drafts are picked.
const bioN = argN('--bios', 20);
if (bioN > 0) {
  const out = run(`4a. bios · up to ${bioN} from the paste list`, ['bio', '--', '--paste-list', '--limit', String(bioN)], BATCH ?? {});
  const got = out.match(/^FOUND (.+)$/m)?.[1];
  if (got) run(`4a. judge · ${got.split(',').length} with a bio now`, ['judge', '--', '--ids', got], BATCH ?? {});
}

// 4b. first drafts for the strongest, so the operator edits rather than drafts.
if (draftN > 0) {
  const picks = draftPicks(draftN);
  for (let i = 0; i < picks.length; i += 3) {
    // Three at a time, each its own step: a draft is a minute or two, and one
    // slow note must not take the others' time limit with it.
    await Promise.all(picks.slice(i, i + 3).map((p) => runAsync(`4b. draft · ${p.name} · ${p.channel}`,
      ['draft', '--', '--person', p.person_id, '--channel', p.channel, '--no-dash'])));
  }
}

// 4c. grade this morning's drafts with a model other than the drafter, so a
// note that recites the reader's own post, or points at something it never
// named, is flagged on the card before the operator edits it.
if (draftN > 0) run('4c. grade · this morning\'s drafts', ['grade', '--', '--since', started], BATCH ?? {});

// 5. pages
run('5. dash', ['dash']);

// summary
if (!dry) {
  const cost = q(`SELECT ROUND(SUM(cost_usd), 3) c, SUM(tavily_credits) t FROM runs WHERE started_at >= ?`, started)[0];
  const judged = q(`SELECT COUNT(DISTINCT person_id) n FROM judgments WHERE created_at >= ?`, started)[0].n;
  const strong = q(`SELECT COUNT(DISTINCT person_id) n FROM judgments WHERE created_at >= ? AND compelling >= 3`, started)[0].n;
  const drafted = q(`SELECT COUNT(*) n FROM drafts WHERE created_at >= ?`, started)[0].n;
  // The page's own count: it already knows who is live, uncontacted and undecided.
  let waiting = '?';
  try { waiting = readFileSync(resolve(ROOT, 'data/dash/ready.html'), 'utf8').match(/(\d+) to decide/)?.[1] ?? '0'; } catch { /* no page yet */ }
  console.log(heading('done'));
  console.log(`  searches ${searched ? 'ran' : 'skipped'} · agendas ${agendas ? 'ran' : 'skipped'} · ${vetted.length} firm(s) vetted, ${alive.length} alive · `
    + `${judged} judged, ${strong} rated 3+ · ${drafted} drafted · $${cost.c ?? 0} model cost · ${cost.t ?? 0} search credits`);
  console.log(`  ${waiting} people waiting on the Ready page`);
  // THE OPERATOR'S PART OF THE MORNING: the strongest writable people with no
  // profile on file. A draft waits for one; tomorrow's run writes it.
  const db = openDb();
  try {
    const screened = db.prepare('SELECT COUNT(DISTINCT person_id) n FROM screens WHERE created_at >= ?').get(started)?.n ?? 0;
    const paste = pasteQueue(db, 20);
    console.log(`  ${screened} screened · ${paste.length} profile(s) to paste today${paste.length ? ':' : ''}`);
    for (const p of paste) console.log(`    ${p.rating}/5  ${p.name} — ${p.title ?? ''}, ${p.org_name ?? p.org_id}`);
  } catch { /* screens table not created yet */ } finally { db.close(); }
  console.log(dim('  open http://127.0.0.1:8787/ready.html'));
}
