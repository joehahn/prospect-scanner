// Stage 5h: a public comment on a fresh post, found in a profile the operator pasted.
//
// A pasted profile carries its Activity section, and a few of those carry a
// post the person wrote in the last few days. A short, useful comment there is
// seen by the poster and their network while the post is still in feeds, and
// the operator's headline beside it does whatever selling there is. Measured on
// 507 pastes, 2026-10-17: about one in nine had the person's own post a week
// old or less, and about one in ten of those was worth a comment. So most
// pastes cost nothing here, and the rest cost one short call.
//
// NOTHING HERE TOUCHES LINKEDIN. It reads text the operator copied himself and
// already stored with its provenance marker. It drafts; he posts, by hand, and
// records what he posted.
//
// Usage:
//   npm run comment -- --person <id> [--redo]      the latest paste for one person
//   npm run comment -- --recent [days] [--dry]     every paste of the last N days (default 7)
//   npm run comment -- --posted <id> --file <f>    record what he posted
//   npm run comment -- --skip <id>
//   npm run comment -- --replied <id> [--file <f>] [--date YYYY-MM-DD]   what they said back
//   npm run comment -- --email <id>

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';
import { loadConfig } from './config.mjs';
import { loadBusiness } from './business.mjs';
import { complete, promptBody } from './models.mjs';
import { neverClaimHits } from './never-claim.mjs';
import { heading, bold, dim } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_FILE = 'prompts/draft-comment.md';
const VOICE_FILE = 'prompts/comment-voice.md';
// A comment pays off in the first few days. Seven, counted from today, so a post
// already a week old when pasted never costs a call.
export const WINDOW_DAYS = 7;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['worthy', 'post_date', 'post_excerpt', 'summary', 'why', 'draft_a', 'draft_b', 'draft_why'],
  properties: {
    worthy: { type: 'boolean' },
    post_date: { type: 'string', description: 'YYYY-MM-DD, or "" when no post qualifies.' },
    post_excerpt: { type: 'string', description: 'The first ten or so words of the chosen post, as pasted.' },
    summary: { type: 'string', description: 'What the post says, in one or two plain sentences.' },
    why: { type: 'string', description: 'Why it is worth a comment, or which test it fails.' },
    draft_a: { type: 'string' },
    draft_b: { type: 'string' },
    draft_why: { type: 'string', description: 'Why draft A is the comment to post.' },
  },
};

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const UNIT_DAYS = { m: 1 / 1440, h: 1 / 24, d: 1, w: 7, mo: 30, yr: 365 };

/** The Activity section of a pasted profile, or null when it has none. */
export function activitySection(body) {
  const lines = String(body ?? '').split('\n');
  const start = lines.findIndex((l) => l.trim() === 'Activity');
  if (start < 0) return null;
  const rest = lines.slice(start);
  const end = rest.findIndex((l, i) => i > 0
    && /^(Experience|Education|About|Skills|Licenses & certifications|Interests|Volunteering)$/.test(l.trim()));
  return rest.slice(0, end > 0 ? end : 400).join('\n').slice(0, 12000);
}

/**
 * Every date that opens a line of an Activity section, as days before `now`.
 * LinkedIn prints "Sep 23", "Dec 5, 2023" or "10mo"; a summary pasted by hand
 * writes "2d — text". Relative ages count back from the paste, not from today.
 */
export function postAges(section, pastedAt, now = new Date()) {
  const pasted = new Date(pastedAt);
  const ages = [];
  for (const raw of String(section ?? '').split('\n')) {
    const l = raw.trim();
    let d = null; let m;
    if ((m = l.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(?:, (\d{4}))?(?![\d])/))) {
      const y = m[3] ? Number(m[3]) : pasted.getUTCFullYear();
      d = new Date(Date.UTC(y, MONTHS[m[1]], Number(m[2])));
      // A date with no year that lands after the paste was last year's.
      if (!m[3] && d > pasted) d.setUTCFullYear(y - 1);
    } else if ((m = l.match(/^(\d+)\s?(mo|yr|m|h|d|w)\b/))) {
      d = new Date(pasted.getTime() - Number(m[1]) * UNIT_DAYS[m[2]] * 86400000);
    }
    if (d) ages.push((now.getTime() - d.getTime()) / 86400000);
  }
  return ages;
}

/** Whether a paste holds anything young enough to be worth a call. */
export function hasFreshPost(body, pastedAt, now = new Date(), windowDays = WINDOW_DAYS) {
  const section = activitySection(body);
  if (!section) return false;
  return postAges(section, pastedAt, now).some((a) => a >= -1 && a <= windowDays);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

// ONLY THE EXAMPLES, not the file's explanation of itself: everything after the
// --- line. A fresh clone has no voice file, and gets the posted comments alone.
function voiceExamples(db) {
  let file = '';
  try {
    const raw = readFileSync(resolve(ROOT, VOICE_FILE), 'utf8');
    const at = raw.indexOf('\n---\n');
    file = (at < 0 ? raw : raw.slice(at + 5)).trim();
  } catch { /* none */ }
  // What he actually posted outranks what he once liked, so the latest go first.
  const posted = db.prepare(`SELECT posted_text FROM comments WHERE posted_text IS NOT NULL
      ORDER BY posted_at DESC LIMIT 8`).all().map((r) => `- "${r.posted_text.replace(/\s+/g, ' ').trim()}"`);
  return [posted.length ? `Comments the operator posted, latest first:\n${posted.join('\n')}` : '',
    file ? `Comments the operator likes:\n${file}` : ''].filter(Boolean).join('\n\n');
}

function operatorBrief(cfg, business) {
  const you = business.you ?? {};
  const list = (xs) => (xs ?? []).map((x) => `- ${typeof x === 'string' ? x : x.claim}`).join('\n');
  return [
    `## What the operator works on`,
    business.offers.filter((o) => (o.status ?? 'live') === 'live')
      .map((o) => `- ${o.name}${o.for ? `: for ${o.for}` : ''}`).join('\n'),
    you.strengths?.length ? `\n## The operator's strengths (stay within these)\n${list(you.strengths)}` : '',
    you.proof_points?.length ? `\n## Public proof points (no client names)\n${list(you.proof_points)}` : '',
    `\n## Never claim\n${list(cfg.operator?.never_claim ?? you.never_claim)}`,
  ].filter(Boolean).join('\n');
}

async function commentOne(db, runId, ctx, person, paste) {
  const org = db.prepare('SELECT name FROM orgs WHERE id = ?').get(person.org_id) ?? {};
  const today = new Date().toISOString().slice(0, 10);
  const user = [
    `Today is ${today}. The window is ${WINDOW_DAYS} days: only a post dated ${WINDOW_DAYS} days ago or later qualifies.`,
    `The profile was pasted on ${String(paste.retrieved_at).slice(0, 10)}.`,
    ``,
    `## The person`,
    `${person.name} — ${person.title ?? '(no title)'}, ${org.name ?? person.org_id}`,
    ``,
    ctx.brief,
    ``,
    ctx.examples ? `## Examples of the operator's comments (match the register, not the topics)\n${ctx.examples}\n` : '',
    `## The Activity section, as the operator pasted it`,
    activitySection(paste.body),
  ].join('\n');
  const res = await complete(db, runId, {
    model: ctx.model, maxTokens: 6000, schema: SCHEMA, system: ctx.prompt,
    messages: [{ role: 'user', content: user }],
  });
  const d = res.data ?? {};
  // THE SAME LITERAL SCREEN THE NOTES PASS. A comment is public, under his name,
  // so a draft naming something he never claims is dropped, not shown.
  const clean = (t) => {
    const s = String(t ?? '').trim();
    return s && !neverClaimHits(s, ctx.neverClaim).length ? s : '';
  };
  const a = clean(d.draft_a); const b = clean(d.draft_b);
  const worthy = Boolean(d.worthy) && Boolean(a || b);
  db.prepare(`INSERT INTO comments (person_id, evidence_id, worthy, post_date, post_excerpt, summary, why,
      draft_a, draft_b, draft_why, model, prompt_file, cost_usd, run_id, created_at)
    VALUES (@person, @ev, @worthy, @date, @excerpt, @summary, @why, @a, @b, @dwhy, @model, @pf, @cost, @run, @now)`)
    .run({ person: person.id, ev: paste.id, worthy: worthy ? 1 : 0, date: d.post_date || null,
      excerpt: d.post_excerpt ?? '', summary: d.summary ?? '',
      why: (d.why ?? '') + (d.worthy && !worthy ? ' (drafts dropped: they named something on the never-claim list)' : ''),
      a: worthy ? (a || b) : '', b: worthy && a ? b : '',
      // The reason is A's; when A was dropped and B stands in, it no longer applies.
      dwhy: worthy && a ? String(d.draft_why ?? '').trim() : '', model: res.model ?? ctx.model, pf: PROMPT_FILE,
      cost: res.cost_usd ?? 0, run: runId, now: new Date().toISOString() });
  return { worthy, why: d.why ?? '', summary: d.summary ?? '', cost: res.cost_usd ?? 0 };
}

function record(db, args) {
  const id = Number(args.posted ?? args.skip ?? args.replied ?? args.email);
  const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  if (!row) throw new Error(`no comment ${id}`);
  const now = new Date().toISOString();
  if (args.posted) {
    const text = args.file && args.file !== true ? readFileSync(String(args.file), 'utf8').trim() : '';
    if (!text) throw new Error('--posted needs --file with the comment as posted');
    db.prepare('UPDATE comments SET posted_text = ?, posted_at = ?, skipped_at = NULL WHERE id = ?').run(text, now, id);
    console.log(`posted comment ${id} recorded`);
  } else if (args.skip) {
    db.prepare('UPDATE comments SET skipped_at = ? WHERE id = ?').run(now, id);
    console.log(`comment ${id} skipped`);
  } else if (args.replied) {
    // Their words, when he pastes them, so a note can build on the thread.
    const text = args.file && args.file !== true ? readFileSync(String(args.file), 'utf8').trim() : '';
    const date = args.date && args.date !== true ? String(args.date) : now.slice(0, 10);
    db.prepare(`UPDATE comments SET replied = 1, replied_at = COALESCE(replied_at, ?),
        reply_text = COALESCE(NULLIF(?, ''), reply_text) WHERE id = ?`).run(date, text, id);
    console.log(`comment ${id}: they replied${text ? ', their reply recorded' : ''}`);
  } else {
    db.prepare('UPDATE comments SET led_to_email = 1 WHERE id = ?').run(id);
    console.log(`comment ${id}: led to an email`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb();
  if (args.posted || args.skip || args.replied || args.email) { record(db, args); db.close(); return; }

  const latestPaste = db.prepare(`SELECT id, person_id, retrieved_at, body FROM evidence
      WHERE kind = 'operator_profile' AND person_id = ? AND body IS NOT NULL ORDER BY id DESC LIMIT 1`);
  let pastes;
  if (args.person && args.person !== true) {
    pastes = [latestPaste.get(String(args.person))].filter(Boolean);
  } else if (args.recent) {
    const days = Number(args.recent === true ? WINDOW_DAYS : args.recent) || WINDOW_DAYS;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    pastes = db.prepare(`SELECT DISTINCT person_id FROM evidence
        WHERE kind = 'operator_profile' AND retrieved_at >= ? AND body IS NOT NULL`).all(since)
      .map((r) => latestPaste.get(r.person_id)).filter(Boolean);
  } else {
    console.log('Pass --person <id>, or --recent [days].');
    db.close(); return;
  }
  const done = new Set(db.prepare('SELECT evidence_id FROM comments').all().map((r) => r.evidence_id));
  const now = new Date();
  pastes = pastes.filter((p) => (args.redo || !done.has(p.id)) && hasFreshPost(p.body, p.retrieved_at, now));
  console.log(heading(`COMMENT — ${pastes.length} paste(s) with a post from the last ${WINDOW_DAYS} days`));
  if (!pastes.length || args.dry) {
    for (const p of pastes) console.log(`  ${p.person_id}`);
    db.close(); return;
  }

  const cfg = await loadConfig();
  const business = loadBusiness(cfg);
  const ctx = {
    model: cfg.models.draft ?? cfg.models.default,
    prompt: promptBody(PROMPT_FILE),
    brief: operatorBrief(cfg, business),
    examples: voiceExamples(db),
    neverClaim: cfg.operator?.never_claim ?? business.you?.never_claim,
  };
  const runId = startRun(db, 'comment', { model: ctx.model });
  let spent = 0; let worthy = 0;
  for (const p of pastes) {
    const person = db.prepare('SELECT * FROM people WHERE id = ?').get(p.person_id);
    if (!person) continue;
    const r = await commentOne(db, runId, ctx, person, p);
    spent += r.cost; if (r.worthy) worthy++;
    console.log(`  ${r.worthy ? bold('COMMENT') : dim('no     ')} ${String(person.name).padEnd(24)} `
      + dim(String(r.worthy ? r.summary : r.why).slice(0, 90)));
  }
  console.log(dim(`\n  ${worthy} worth a comment of ${pastes.length} · $${spent.toFixed(4)}`));
  finishRun(db, runId, { cost_usd: spent, n_in: pastes.length, n_out: worthy });
  db.close();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
