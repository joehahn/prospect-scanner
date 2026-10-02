// Would the operator write to this person? Judged from his own past decisions.
//
// WHY THIS EXISTS. The ranker encodes the
// operator's judgment indirectly, through persona title lists, weights and
// exemptions, and when it disagrees with him there is no one place his judgment
// lives. The drafter got better when rules gave way to examples of notes he had
// sent. This is the same move for choosing whom to write to: show the model the
// past decisions most like this candidate, and let it follow his lead.
//
// It runs ALONGSIDE the ranker and replaces nothing. Whether it ever does is
// decided by `--eval`, which scores it against his real decisions.
//
// WHAT IS JUDGED AND WHAT IS NOT. Timing (days since the freshest dated event)
// and Reach (the channel on file) are facts, computed here with no model. The
// model answers only what needs judgment: Need, Owner, Value, and write/skip.
//
// PAST DECISIONS come from the record, nothing curated: every person he wrote to
// (a reply marks the strongest), and every write/skip he clicked on a card, the
// latest call per person winning. For each candidate the dozen most similar are
// chosen -- shared thesis, shared trigger, size band, title words -- balanced
// between writes and skips, and the candidate's own record is always excluded,
// so a judgment is never graded on an example of itself.
//
// NOTHING ABOUT THE OPERATOR IS WRITTEN HERE. Offers, prices and target
// descriptions are read from config at run time; see CLAUDE.md.
//
// NONDETERMINISTIC BY NATURE, so each person is judged `--runs` times (default
// 3) and the majority is reported with its agreement. A 2-of-3 is a flag, not a
// verdict.
//
// Usage:
//   npm run judge -- --person <id> [--runs 3]
//   npm run judge -- --ids a,b,c [--jobs 4]    these people, four at a time
//   npm run judge -- --queue [--limit 15]     the people the ranker would put up first,
//                                             skipping anyone judged in the last 7 days
//                                             unless --redo; they fill the Ready page
//   npm run judge -- --eval [--limit 20]      judge people he has already decided
//                                             about and score agreement with him
//   npm run judge -- --show <id>              the latest judgment, in full
//   npm run judge -- --screen --backlog [--limit 600]
//                                             one cheap pass over people never judged or
//                                             screened, so the full judge spends three runs
//                                             only on the ones worth it (table `screens`)
//   npm run judge -- --screen --ids a,b,c     screen these people
//   npm run judge -- --screen --eval [--limit 60]
//                                             screen people the full judge has rated and
//                                             report how well the screen predicts it
//   npm run judge -- --passed [--min 3] [--limit 150]
//                                             judge, in full, the best screened people
//                                             not yet judged
//   npm run judge -- --scoreboard             judge vs ranker on his forward calls, blind apart
//                                  [--since <ISO time>]  one round only

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { loadTargeting } from './targeting.mjs';
import { loadBusiness, describeForJudge } from './business.mjs';
import { scoreboard } from './measures.mjs';
import { complete, batchMode } from './models.mjs';
import { heading, bold, dim, truncate } from './report.mjs';
import { retense } from './events.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = 'prompts/judge.md';
const DAY_MS = 86_400_000;

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['need', 'need_why', 'owner', 'owner_why', 'better_recipient', 'value', 'value_why',
    'compelling', 'reason', 'against_example', 'target'],
  properties: {
    need: { type: 'string', enum: ['named', 'plausible', 'none'] },
    need_why: { type: 'string' },
    owner: { type: 'string', enum: ['owns', 'influences', 'no'] },
    owner_why: { type: 'string' },
    better_recipient: { type: 'string', description: '"Name — Title" when owner is no and the evidence names someone; "" otherwise.' },
    value: { type: 'string', enum: ['1', '2', '3'] },
    value_why: { type: 'string' },
    compelling: { type: 'string', enum: ['1', '2', '3', '4', '5'],
      description: 'How compelling a note to this person is now, 1 to 5. See the prompt.' },
    reason: { type: 'string', description: 'One plain sentence for the card.' },
    against_example: { type: 'string', description: 'If the verdict goes against the closest example, which one and why. "" otherwise.' },
    target: { type: 'string', description: 'The operator target this person fits, by its exact name as given, or "none".' },
  },
};

const STOP = new Set(['the', 'and', 'for', 'of', 'at', 'vice', 'senior', 'head', 'group', 'global',
  'officer', 'president', 'director', 'manager', 'chief', 'executive', 'svp', 'evp']);
const words = (t) => new Set(String(t ?? '').toLowerCase().split(/[^a-z]+/)
  .filter((w) => w.length > 2 && !STOP.has(w)));

function sizeBand(o) {
  const h = o?.headcount_est;
  if (h != null) return h >= 5000 ? 'xl' : h >= 1000 ? 'l' : h >= 200 ? 'm' : 's';
  const r = o?.revenue_basis === 'revenue' ? o?.revenue_est : null;
  if (r) return r >= 3e9 ? 'xl' : r >= 1.5e8 ? 'l' : r >= 3e7 ? 'm' : 's';
  return 'unknown';
}

function features(db, personId) {
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) return null;
  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(person.org_id) ?? {};
  const verticals = db.prepare('SELECT vertical_id FROM org_verticals WHERE org_id = ?')
    .all(person.org_id).map((r) => r.vertical_id);
  const triggers = db.prepare(`SELECT DISTINCT trigger_id FROM signals
    WHERE org_id = ? AND retracted_at IS NULL`).all(person.org_id).map((r) => r.trigger_id);
  return { person, org, verticals, triggers, band: sizeBand(org), title: words(person.title) };
}

/** Every decision on record, latest per person. */
function pastDecisions(db) {
  const out = new Map();
  for (const o of db.prepare(`SELECT o.person_id, o.sent_at at, o.status, o.message_text, o.pitch_summary
      FROM outreach o WHERE o.person_id IS NOT NULL ORDER BY o.sent_at`).all()) {
    const replied = /^responded|open_thread/.test(o.status ?? '');
    out.set(o.person_id, { person_id: o.person_id, decision: 'write', at: o.at,
      strength: replied ? 'wrote, and got a reply' : 'wrote',
      why: truncate(String(o.message_text ?? o.pitch_summary ?? '').replace(/\s+/g, ' ').trim(), 280) });
  }
  for (const v of db.prepare(`SELECT person_id, verdict, first, reason, created_at at FROM verdicts ORDER BY id`).all()) {
    const prev = out.get(v.person_id);
    if (prev && String(prev.at) > String(v.at).slice(0, 10)) continue;
    out.set(v.person_id, { person_id: v.person_id, decision: v.verdict, at: v.at,
      strength: v.first ? 'marked WRITE FIRST, among the most compelling'
        : v.verdict === 'write' ? 'marked would write (an opening, not a first pick)' : 'marked would not write',
      why: v.reason ?? prev?.why ?? '' });
  }
  return [...out.values()];
}

function similarity(a, b) {
  let s = 0;
  if (a.verticals.some((v) => b.verticals.includes(v))) s += 3;
  s += 2 * Math.min(2, a.triggers.filter((t) => b.triggers.includes(t)).length);
  if (a.band !== 'unknown' && a.band === b.band) s += 2;
  if (a.org.kind && a.org.kind === b.org.kind) s += 1;
  const inter = [...a.title].filter((w) => b.title.has(w)).length;
  const union = new Set([...a.title, ...b.title]).size || 1;
  return s + 3 * (inter / union);
}

function examplesFor(db, cand, decisions, k = 12) {
  const scored = [];
  for (const d of decisions) {
    if (d.person_id === cand.person.id) continue;
    const f = features(db, d.person_id);
    if (!f) continue;
    scored.push({ ...d, f, score: similarity(cand, f) });
  }
  scored.sort((x, y) => y.score - x.score);
  const skips = scored.filter((x) => x.decision === 'skip').slice(0, Math.floor(k / 2));
  const writes = scored.filter((x) => x.decision === 'write').slice(0, k - skips.length);
  return [...writes, ...skips].sort((x, y) => y.score - x.score);
}

/** What the operator's own network says about this person. Facts, not judgment. */
function tie(p) {
  const bits = [];
  if (p.degree === 1) bits.push('a first-degree connection of the operator');
  else if (p.degree === 2) bits.push('second-degree');
  if (String(p.prior_relationship ?? '').trim()) bits.push(`known to the operator: ${truncate(p.prior_relationship, 160)}`);
  if (p.referral_value >= 0.4) bits.push('well connected; could refer the operator on');
  return bits.join('; ');
}

function describe(f) {
  const size = f.org.headcount_est ? `${f.org.headcount_est.toLocaleString('en-US')} people`
    : f.org.revenue_est && f.org.revenue_basis === 'revenue' ? `~$${(f.org.revenue_est / 1e6).toFixed(0)}m revenue`
    : 'size unknown';
  return `${f.person.title ?? 'title unknown'} at ${f.org.name ?? f.person.org_id} (${f.org.kind ?? 'kind unknown'}, ${size})`
    + (f.verticals.length ? `; target type: ${f.verticals.join(', ')}` : '')
    + (f.triggers.length ? `; events: ${f.triggers.join(', ')}` : '')
    + (tie(f.person) ? `; ${tie(f.person)}` : '');
}

/** Days since the freshest reason to write, and what it was. No model. */
function timing(db, f) {
  const sig = db.prepare(`SELECT trigger_id, detected_at FROM signals WHERE org_id = ?
    AND retracted_at IS NULL ORDER BY detected_at DESC LIMIT 1`).get(f.person.org_id);
  const seat = f.person.in_seat_since ? `${f.person.in_seat_since}-01`.slice(0, 10) : null;
  const cands = [sig && { at: sig.detected_at, what: sig.trigger_id },
                 seat && { at: seat, what: 'took the seat' }].filter(Boolean)
    .filter((x) => Number.isFinite(Date.parse(x.at)));
  if (!cands.length) return { days: null, what: 'no dated event on file' };
  const best = cands.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  return { days: Math.max(0, Math.round((Date.now() - Date.parse(best.at)) / DAY_MS)), what: best.what };
}

/** Will a message land? No model. */
function reach(p) {
  if (p.email) return 'email (verified)';
  if (p.email_guess) return 'email (guessed pattern)';
  if (p.profile_url) {
    return ['active', 'high'].includes(p.platform_activity) ? 'InMail, active on LinkedIn'
      : ['low', 'dormant'].includes(p.platform_activity) ? 'InMail, rarely on LinkedIn' : 'InMail';
  }
  return 'no channel on file';
}

function operatorBlock(cfg, targeting) {
  // FROM THE BUSINESS FILE (src/business.mjs), which falls back to the old
  // files when there is none. Every target is given, so the judge decides which
  // one a candidate fits instead of being told by the old thesis assignment.
  return describeForJudge(loadBusiness(cfg, targeting));
}

function candidateBlock(db, f, t, r) {
  const read = db.prepare(`SELECT trying_to_do, in_the_way, next_step, what_an_hour_does, recipient,
      better_recipient, confidence FROM reads WHERE person_id = ? AND rejected_at IS NULL
      ORDER BY id DESC LIMIT 1`).get(f.person.id);
  const ev = db.prepare(`SELECT id, kind, claim, provenance FROM evidence
      WHERE (person_id = ? OR (org_id = ? AND person_id IS NULL)) AND kind <> 'operator_profile' AND kind <> 'web_page'
      ORDER BY (person_id = ?) DESC, (provenance = 'operator_supplied') DESC, id DESC LIMIT 30`)
    .all(f.person.id, f.person.org_id, f.person.id);
  // ^ Never a colleague's evidence: see buildDossier in draft.mjs.
  const sigs = db.prepare(`SELECT trigger_id, detected_at FROM signals WHERE org_id = ?
      AND retracted_at IS NULL ORDER BY detected_at DESC LIMIT 6`).all(f.person.org_id);
  return [
    '## The candidate',
    `${f.person.name} — ${describe(f)}`,
    f.person.in_seat_since ? `In the seat since ${f.person.in_seat_since}.` : '',
    f.person.location ? `Based in ${f.person.location}.` : '',
    `Timing: ${t.days == null ? t.what : `${t.days} days since ${t.what}`}.`,
    `Reach: ${r}.`,
    sigs.length ? `Dated events at the firm: ${sigs.map((s) => `${s.trigger_id} (${s.detected_at})`).join('; ')}` : '',
    read ? `\nA prior read of this person (${read.confidence}):\n`
      + `- working toward: ${read.trying_to_do}\n- in the way: ${read.in_the_way}\n`
      + `- next step: ${read.next_step}\n- what outside help changes: ${read.what_an_hour_does}`
      + (read.recipient && read.recipient !== 'this_person'
        ? `\n- the read thought the note belongs with: ${read.better_recipient || read.recipient}` : '')
      : '\nNo prior read.',
    '\nOn file:',
    ...ev.map((e) => `- [e${e.id}] ${truncate(retense(String(e.claim)).replace(/\s+/g, ' '), 260)}`
      + (e.provenance === 'operator_supplied' ? ' (from the operator)' : '')),
  ].filter(Boolean).join('\n');
}

function examplesBlock(ex) {
  if (!ex.length) return '## The operator\'s past decisions\n\nNone on record yet. Judge from the descriptions.';
  return ['## The operator\'s past decisions, most similar first', '',
    ...ex.map((x, i) => `${i + 1}. ${x.decision === 'write' ? 'WROTE' : 'SKIPPED'} (${x.strength}) — `
      + `${describe(x.f)}.${x.why ? ` Why: "${x.why}"` : ''}`)].join('\n');
}

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS judgments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT NOT NULL REFERENCES people(id),
    org_id TEXT NOT NULL REFERENCES orgs(id),
    batch TEXT NOT NULL,              -- the runs that form one judgment share this
    verdict TEXT, need TEXT, need_why TEXT, owner TEXT, owner_why TEXT, better_recipient TEXT,
    value TEXT, value_why TEXT, reason TEXT, against_example TEXT,
    timing_days INTEGER, timing_what TEXT, reach TEXT,
    examples TEXT,                    -- person ids of the examples shown, in order
    model TEXT, prompt_file TEXT, cost_usd REAL, run_id INTEGER REFERENCES runs(id),
    created_at TEXT NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_judgments_person ON judgments(person_id)');
  const cols = db.prepare('PRAGMA table_info(judgments)').all().map((c) => c.name);
  if (!cols.includes('compelling')) db.exec('ALTER TABLE judgments ADD COLUMN compelling INTEGER');
  // WHICH TARGET, recorded 2026-09-26. Firms were still filed under the old
  // theses, so nothing tied a person to the operator's new targets; the judge
  // already decides which one fits in order to rate, so it now says so.
  if (!cols.includes('target')) db.exec('ALTER TABLE judgments ADD COLUMN target TEXT');
}

async function judgeOne(db, cfg, targeting, personId, { runs, model, runId, decisions }) {
  const f = features(db, personId);
  if (!f) throw new Error(`no person "${personId}"`);
  const t = timing(db, f);
  const r = reach(f.person);
  const ex = examplesFor(db, f, decisions);
  const content = userContent(cfg, targeting, [candidateBlock(db, f, t, r), '', examplesBlock(ex)].join('\n'));
  const system = readFileSync(resolve(ROOT, PROMPT_FILE), 'utf8');
  const batch = `${personId}@${new Date().toISOString()}`;
  const results = await Promise.all(Array.from({ length: runs }, () => complete(db, runId, {
    model, system, schema: SCHEMA, effort: 'medium', maxTokens: 4000,
    messages: [{ role: 'user', content }] })));
  const targetNames = loadBusiness(cfg, targeting).targets.map((t) => t.name);
  const ins = db.prepare(`INSERT INTO judgments (person_id, org_id, batch, verdict, compelling, target, need,
    need_why, owner, owner_why, better_recipient, value, value_why, reason, against_example, timing_days,
    timing_what, reach, examples, model, prompt_file, cost_usd, run_id, created_at)
    VALUES (@p, @o, @b, @verdict, @compelling, @target, @need, @need_why, @owner, @owner_why, @better_recipient,
    @value, @value_why, @reason, @against_example, @td, @tw, @reach, @ex, @model, @pf, @cost, @run, @now)`);
  let cost = 0;
  const outs = [];
  for (const res of results) {
    cost += res.cost_usd ?? 0;
    if (!res.data) continue;
    outs.push(res.data);
    // `verdict` is kept, derived, so older readers still work: 3 and up is a write.
    const c = Number(res.data.compelling);
    // The target by the business file's own name, matched loosely, or null.
    const want = String(res.data.target ?? '').trim().toLowerCase();
    const target = want && want !== 'none'
      ? (targetNames.find((n) => n.toLowerCase() === want)
        ?? targetNames.find((n) => n.toLowerCase().includes(want) || want.includes(n.toLowerCase())) ?? null)
      : null;
    ins.run({ p: personId, o: f.person.org_id, b: batch, ...res.data, compelling: c, target,
      verdict: c >= 3 ? 'write' : 'skip', td: t.days, tw: t.what, reach: r,
      ex: ex.map((x) => x.person_id).join(','), model: res.model ?? model, pf: PROMPT_FILE,
      cost: res.cost_usd ?? 0, run: runId, now: new Date().toISOString() });
  }
  // THE MIDDLE RATING of the runs, and how far apart they were. A spread of two
  // or more is the runs disagreeing about this person, and is flagged.
  const ratings = outs.map((o) => Number(o.compelling)).sort((a, b) => a - b);
  const rating = ratings[Math.floor(ratings.length / 2)] ?? null;
  const spread = ratings.length ? ratings[ratings.length - 1] - ratings[0] : 0;
  const pick = outs.find((o) => Number(o.compelling) === rating) ?? outs[0] ?? {};
  const verdict = rating >= 3 ? 'write' : 'skip';
  const agree = outs.filter((o) => (Number(o.compelling) >= 3) === (verdict === 'write')).length;
  return { person: f.person, verdict, rating, spread, agree, of: outs.length, pick, t, r, cost, examples: ex.length };
}

// ---- the screen -----------------------------------------------------------
// THE SAME QUESTION, ONCE, ON THE CHEAP MODEL. Added 2026-10-02. The full judge
// is three runs on the default model at about 3.5 cents a person, which held the
// morning to 150 people while 3,700 sat unjudged. The screen asks the identical
// question with the identical prompt and evidence, once, on cfg.models.cheap,
// and the full judge then runs only on the people it passes. Kept in its own
// table so nothing that reads `judgments` -- the Ready page, the draft picks,
// the Scoreboard -- ever mistakes a screen for a judgment. Whether it is good
// enough to stand in front of the judge is measured, not assumed: --screen --eval.
function ensureScreens(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS screens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT NOT NULL REFERENCES people(id),
    org_id TEXT NOT NULL REFERENCES orgs(id),
    compelling INTEGER, target TEXT, reason TEXT,
    model TEXT, prompt_file TEXT, cost_usd REAL, run_id INTEGER REFERENCES runs(id),
    created_at TEXT NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_screens_person ON screens(person_id)');
}

async function screenOne(db, cfg, targeting, personId, { model, runId, decisions }) {
  const f = features(db, personId);
  if (!f) throw new Error(`no person "${personId}"`);
  const t = timing(db, f);
  const r = reach(f.person);
  const content = userContent(cfg, targeting,
    [candidateBlock(db, f, t, r), '', examplesBlock(examplesFor(db, f, decisions))].join('\n'));
  const res = await complete(db, runId, { model, system: readFileSync(resolve(ROOT, PROMPT_FILE), 'utf8'),
    schema: SCHEMA, effort: 'low', maxTokens: 2000, messages: [{ role: 'user', content }] });
  const c = Number(res.data?.compelling);
  db.prepare(`INSERT INTO screens (person_id, org_id, compelling, target, reason, model, prompt_file, cost_usd, run_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(personId, f.person.org_id, Number.isFinite(c) ? c : null,
    res.data?.target ?? null, res.data?.reason ?? null, res.model ?? model, PROMPT_FILE, res.cost_usd ?? 0, runId,
    new Date().toISOString());
  return { person: f.person, rating: Number.isFinite(c) ? c : null, reason: res.data?.reason ?? '', cost: res.cost_usd ?? 0 };
}

/** People never judged and never screened, at live firms, one per firm, ranker's order. */
function backlogIds(db, limit) {
  return db.prepare(`
    WITH latest AS (SELECT * FROM person_scores s
                     WHERE id = (SELECT MAX(id) FROM person_scores x WHERE x.person_id = s.person_id))
    SELECT l.person_id FROM latest l JOIN people p ON p.id = l.person_id
     WHERE l.person_id = (SELECT l2.person_id FROM latest l2 WHERE l2.org_id = l.org_id
             AND l2.person_id NOT IN (SELECT person_id FROM judgments)
             AND l2.person_id NOT IN (SELECT person_id FROM screens)
             ORDER BY l2.total DESC LIMIT 1)
       AND l.org_id NOT IN (SELECT org_id FROM gate_results WHERE outcome LIKE 'kill%')
       AND l.person_id NOT IN (SELECT person_id FROM outreach WHERE person_id IS NOT NULL)
       AND l.org_id NOT IN (SELECT org_id FROM do_not_contact WHERE org_id IS NOT NULL)
       AND l.person_id NOT IN (SELECT person_id FROM do_not_contact WHERE person_id IS NOT NULL)
       AND COALESCE((SELECT v.verdict FROM verdicts v WHERE v.person_id = l.person_id
             ORDER BY v.id DESC LIMIT 1), '') <> 'skip'
     -- New people first: the week a trigger is newest is the week it is worth most.
     ORDER BY (SELECT MIN(retrieved_at) FROM evidence e WHERE e.person_id = l.person_id)
                >= datetime('now', '-7 days') DESC, l.total DESC LIMIT ?`).all(limit).map((r) => r.person_id);
}

/** The best screened people the full judge has not seen, highest screen first. */
function passedIds(db, min, limit) {
  return db.prepare(`SELECT s.person_id FROM screens s
     WHERE s.id = (SELECT MAX(id) FROM screens x WHERE x.person_id = s.person_id)
       AND s.compelling >= ? AND s.person_id NOT IN (SELECT person_id FROM judgments)
       AND s.person_id NOT IN (SELECT person_id FROM outreach WHERE person_id IS NOT NULL)
     ORDER BY s.compelling DESC, s.id LIMIT ?`).all(min, limit).map((r) => r.person_id);
}

// THE OPERATOR'S PART IS THE SAME FOR EVERY CANDIDATE, so it is its own block
// with a cache breakpoint: after the system prompt it is the longest stable
// prefix the judge and the screen send, and it was billed in full on every call.
function userContent(cfg, targeting, rest) {
  return [{ type: 'text', text: operatorBlock(cfg, targeting), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: rest }];
}

function line(j) {
  const flag = j.spread >= 2 ? bold(` spread ${j.spread}`) : '';
  return `  ${bold(`${j.rating}/5`)}${flag}  ${String(j.person.name).padEnd(24)} `
    + dim(`Need ${j.pick.need} · Owner ${j.pick.owner} · Value ${j.pick.value} · `
      + `${j.t.days == null ? 'undated' : `${j.t.days}d`} · ${j.r}`)
    + `\n           ${truncate(j.pick.reason ?? '', 150)}`;
}

/**
 * Who to judge next: everyone at a live firm not yet contacted, suppressed or
 * held -- the same people the Ready page can show -- in the ranker's order, so
 * the likeliest go first.
 *
 * NOT FILTERED BY THE RANKER'S BLOCKERS, changed 2026-09-25. Those include "no
 * profile on file" and "no channel", which in the redesign are the Reach axis:
 * something the judge weighs, not a reason nobody may look. Filtering on them
 * ran the queue dry after 78 people with the blind test barely started.
 */
function queueIds(db, limit) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(`
    WITH latest AS (SELECT * FROM person_scores s
                     WHERE id = (SELECT MAX(id) FROM person_scores x WHERE x.person_id = s.person_id))
    SELECT l.person_id FROM latest l JOIN people p ON p.id = l.person_id
     -- ONE PER FIRM: the ranker's best-placed person at each firm not yet judged.
     -- It places colleagues side by side, and a day's top-up of ten once went to
     -- seven people at one firm, associates and a controller among them.
     WHERE l.person_id = (SELECT l2.person_id FROM latest l2 WHERE l2.org_id = l.org_id
             AND l2.person_id NOT IN (SELECT person_id FROM judgments)
             ORDER BY l2.total DESC LIMIT 1)
       AND l.org_id NOT IN (SELECT org_id FROM gate_results WHERE outcome LIKE 'kill%')
       AND l.person_id NOT IN (SELECT person_id FROM outreach WHERE person_id IS NOT NULL)
       AND l.person_id NOT IN (SELECT person_id FROM hold WHERE release_after > ?)
       AND NOT EXISTS (SELECT 1 FROM do_not_contact d WHERE d.person_id = p.id
             OR (d.org_id = p.org_id AND NOT EXISTS (
                   SELECT 1 FROM outreach o WHERE o.person_id = p.id)))
     ORDER BY l.total DESC LIMIT ?`).all(today, limit).map((r) => r.person_id);
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument "${argv[i]}"`);
    const k = argv[i].slice(2); const n = argv[i + 1];
    if (n && !n.startsWith('--')) { a[k] = n; i++; } else a[k] = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const targeting = loadTargeting(cfg);
  const db = openDb();
  ensureTable(db);
  const model = (args.model && args.model !== true) ? String(args.model)
    : (cfg.models?.judge ?? cfg.models?.default);
  const runs = Math.max(1, Number(args.runs ?? 3) || 3);
  const limit = Number(args.limit ?? 15) || 15;

  if (args.scoreboard) {
    // Computed in measures.mjs, shared with the dashboard's Scoreboard page.
    const sb = scoreboard(db, { since: typeof args.since === 'string' ? args.since : null });
    const f2 = (x) => (x == null ? 'n/a' : x.toFixed(2));
    for (const [label, x] of [['all forward calls', sb.forward], ['blind calls only', sb.blind]]) {
      console.log(`\n${bold(label)}: ${x.calls} (${x.writes} write, ${x.calls - x.writes} skip)`);
      console.log(`  judge agreed with you: ${x.agreed} of ${x.calls}`);
      console.log(`  puts your writes above your skips — judge ${f2(x.judge)} · ranker ${f2(x.ranker)}`);
    }
    for (const d of sb.days) {
      console.log(dim(`  ${d.day}: ${d.cards} cards, ${d.firsts} write-first — judge top ${sb.topK} held ${d.judge}, ranker top ${sb.topK} held ${d.ranker}`));
    }
    console.log(`\n${bold(`Your WRITE FIRST picks in the top ${sb.topK} of their day`)}: `
      + (sb.firsts ? `judge ${sb.judgeFirsts} of ${sb.firsts} · ranker ${sb.rankerFirsts} of ${sb.firsts}` : 'none yet — mark some Write first'));
    console.log(`\n${bold('Changed your mind after seeing the judge')}: ${sb.changed}`
      + dim(' (your first call is the one scored above)'));
    db.close(); return;
  }

  if (args.show) {
    const rows = db.prepare(`SELECT * FROM judgments WHERE batch = (SELECT batch FROM judgments
      WHERE person_id = ? ORDER BY id DESC LIMIT 1)`).all(String(args.show));
    if (!rows.length) { console.log('no judgment on file'); db.close(); return; }
    for (const j of rows) {
      console.log(`\n${bold(j.verdict.toUpperCase())} — ${j.reason}`);
      console.log(`  Need ${j.need}: ${j.need_why}\n  Owner ${j.owner}: ${j.owner_why}`
        + `${j.better_recipient ? ` → ${j.better_recipient}` : ''}\n  Value ${j.value}: ${j.value_why}`);
      if (j.against_example) console.log(`  Against the examples: ${j.against_example}`);
    }
    db.close(); return;
  }

  if (args.screen) {
    ensureScreens(db);
    const decisions = pastDecisions(db);
    const cheap = cfg.models?.cheap;
    if (!cheap) throw new Error('no models.cheap in config/runtime.yml');
    let sids;
    let truth = null;
    if (args.eval) {
      // People the full judge has rated, most recent first, with its middle rating.
      truth = new Map(db.prepare(`SELECT person_id, compelling FROM judgments j
          WHERE batch = (SELECT MAX(batch) FROM judgments x WHERE x.person_id = j.person_id)
          ORDER BY created_at DESC`).all().reduce((m, r) => {
        (m.get(r.person_id) ?? m.set(r.person_id, []).get(r.person_id)).push(r.compelling); return m;
      }, new Map()).entries().map(([k, v]) => [k, v.sort((a, b) => a - b)[Math.floor(v.length / 2)]]));
      sids = [...truth.keys()].slice(0, Number(args.limit ?? 60) || 60);
    } else if (args.ids && args.ids !== true) sids = String(args.ids).split(',').map((x) => x.trim()).filter(Boolean);
    else if (args.backlog) sids = backlogIds(db, Number(args.limit ?? 600) || 600);
    else { console.log('Pass --backlog, --ids or --eval with --screen.'); db.close(); return; }
    console.log(heading(`screen · ${sids.length} person(s) × 1 run · ${cheap}`));
    const runId = startRun(db, 'screen', { model: cheap });
    const got = [];
    let scost = 0;
    let cur = 0;
    // In batch mode every request is queued at once, so they go out as one batch.
    const jobs = batchMode() ? sids.length
      : Math.max(1, Number(args.jobs && args.jobs !== true ? args.jobs : 8) || 8);
    const work = async () => {
      for (let i = cur++; i < sids.length; i = cur++) {
        try { const x = await screenOne(db, cfg, targeting, sids[i], { model: cheap, runId, decisions }); scost += x.cost; got.push(x); }
        catch (e) { console.log(`  FAILED ${sids[i]}: ${e.message}`); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, sids.length) }, work));
    finishRun(db, runId, { n_in: sids.length, n_out: got.length });
    const dist = [1, 2, 3, 4, 5].map((k) => `${k}: ${got.filter((x) => x.rating === k).length}`).join(' · ');
    console.log(`  screened ${got.length} · ${dist}`);
    if (truth) {
      // HOW MUCH OF WHAT THE JUDGE RATES 3+ DOES EACH THRESHOLD KEEP, and how
      // much does it let through. Recall is the number that matters: a person the
      // screen drops is never seen by the judge again.
      const scored = got.filter((x) => truth.get(x.person.id) != null && x.rating != null);
      const strong = scored.filter((x) => truth.get(x.person.id) >= 3);
      for (const th of [2, 3]) {
        const pass = scored.filter((x) => x.rating >= th);
        const kept = strong.filter((x) => x.rating >= th).length;
        console.log(`  pass at ${th}+: ${pass.length} of ${scored.length} go on to the judge · `
          + `keeps ${kept} of ${strong.length} the judge rates 3+`);
      }
      const exact = scored.filter((x) => x.rating === truth.get(x.person.id)).length;
      console.log(dim(`  same rating as the judge: ${exact} of ${scored.length}`));
    }
    console.log(dim(`\n$${scost.toFixed(3)} · $${(scost / Math.max(1, got.length)).toFixed(4)} a person`));
    db.close(); return;
  }

  const decisions = pastDecisions(db);
  let ids;
  if (args.person) ids = [String(args.person)];
  else if (args.ids && args.ids !== true) ids = [...new Set(String(args.ids).split(',').map((x) => x.trim()).filter(Boolean))];
  else if (args.passed) {
    ensureScreens(db);
    ids = passedIds(db, Number(args.min ?? 3) || 3, limit);
  }
  else if (args.queue) {
    // A judgment keeps for a week unless asked. The Ready page is rebuilt often
    // and each judgment costs three model calls; a person whose record has not
    // changed does not need judging again, and `--redo` is there when it has.
    const fresh = new Set(args.redo ? [] : db.prepare(`SELECT DISTINCT person_id FROM judgments
      WHERE created_at >= ?`).all(new Date(Date.now() - 7 * DAY_MS).toISOString()).map((r) => r.person_id));
    ids = queueIds(db, limit + fresh.size).filter((id) => !fresh.has(id)).slice(0, limit);
    if (fresh.size) console.log(dim(`  ${fresh.size} judged in the last 7 days kept as they are; --redo to judge again`));
  }
  else if (args.eval) {
    // Most recent first: the decisions that best reflect how he chooses now.
    ids = [...decisions].sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, limit).map((d) => d.person_id);
  } else {
    console.log('Pass --person <id>, --queue, --eval or --show <id>.');
    db.close(); return;
  }

  console.log(heading(`judge · ${ids.length} person(s) × ${runs} run(s) · ${model} · `
    + `${decisions.length} past decisions on record`));
  const runId = startRun(db, 'judge', { model });
  const done = [];
  let cost = 0;
  // SEVERAL PEOPLE IN FLIGHT, added 2026-10-01 when the daily run went from
  // three people to everyone new. One at a time, 150 people is twenty minutes
  // against a ten-minute step limit. Each person's runs already go in parallel;
  // better-sqlite3 is synchronous, so the writes serialise in this process.
  const jobs = batchMode() ? ids.length
    : Math.max(1, Number(args.jobs && args.jobs !== true ? args.jobs : 4) || 4);
  let cursor = 0;
  const worker = async () => {
    for (let i = cursor++; i < ids.length; i = cursor++) {
      try {
        const j = await judgeOne(db, cfg, targeting, ids[i], { runs, model, runId, decisions });
        cost += j.cost;
        done.push(j);
        console.log(line(j));
      } catch (e) { console.log(`  FAILED ${ids[i]}: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, ids.length) }, worker));
  finishRun(db, runId, {});

  if (args.eval) {
    const actual = new Map(decisions.map((d) => [d.person_id, d.decision]));
    const scored = done.filter((j) => actual.has(j.person.id));
    const hit = scored.filter((j) => j.verdict === actual.get(j.person.id)).length;
    const stable = scored.filter((j) => j.agree === j.of).length;
    // BY CLASS, because the record is lopsided: nearly every decision on file is
    // a note he sent, so a judge that always said "write" would score high
    // overall and be useless. What matters is whether it catches his skips.
    const cls = (c) => { const xs = scored.filter((j) => actual.get(j.person.id) === c);
      return `${xs.filter((j) => j.verdict === c).length} of ${xs.length}`; };
    console.log(`\n${bold('Agreement with the operator')}: ${hit} of ${scored.length}`
      + dim(` (each judged without its own record among the examples)`));
    console.log(`  his writes the judge also wrote: ${cls('write')}`);
    console.log(`  his skips the judge also skipped: ${cls('skip')}`);
    for (const j of scored.filter((x) => x.verdict !== actual.get(x.person.id))) {
      console.log(dim(`  disagreed: ${j.person.name} — he ${actual.get(j.person.id) === 'write' ? 'wrote' : 'skipped'}, judge said ${j.verdict}`));
    }
    console.log(`${bold('Agreement with itself')}: ${stable} of ${scored.length} unanimous across ${runs} runs`);
  }
  console.log(dim(`\n$${cost.toFixed(3)} · npm run judge -- --show <id> for the full reasoning`));
  db.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
