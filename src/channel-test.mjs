// THE CHANNEL TEST: does email draw more replies than LinkedIn?
//
// Asked by the operator on 2026-10-08, after a hundred-odd InMails and
// connection notes: "we should also try the email channel to see if that is
// more or less successful than the others". The record could not answer it.
// Email had gone where an address happened to be on file -- public bodies
// publish theirs, investors do not -- so any difference between channels was a
// difference between the people on them.
//
// So the channel ALTERNATES among comparable people: everyone rated 4+, writable,
// with an address on file (verified or guessed from a published pattern), takes
// the arm the previous assignment did not. The card then suggests that channel.
// The operator still chooses and sends by hand; what he actually sent is what
// gets measured, and the assigned arm only says which cohort a send belongs to.
//
// Replies are counted only on sends old enough to have had one (MATURE_DAYS),
// and a bounce is counted apart from silence: a note that never arrived says
// nothing about the channel.

import { strongWritable } from './funnel.mjs';

export const ARMS = ['email', 'linkedin'];
export const MATURE_DAYS = 14;

export function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS channel_test (
    person_id   TEXT PRIMARY KEY REFERENCES people(id),
    arm         TEXT NOT NULL CHECK (arm IN ('email', 'linkedin')),
    assigned_at TEXT NOT NULL)`);
}

/** The channel family a recorded send belongs to. */
export const familyOf = (channel) => (/email/.test(String(channel ?? '')) ? 'email'
  : /^linkedin/.test(String(channel ?? '')) ? 'linkedin' : null);

/** A person's assigned arm, or null if they are not in the test. */
export function armOf(db, personId) {
  ensureTable(db);
  return db.prepare('SELECT arm FROM channel_test WHERE person_id = ?').get(personId)?.arm ?? null;
}

/**
 * Give each candidate, in order, the arm the last assignment did not take.
 * Candidates already assigned are skipped. Returns the new assignments.
 */
export function assign(db, candidates, now = new Date().toISOString()) {
  ensureTable(db);
  const has = db.prepare('SELECT 1 FROM channel_test WHERE person_id = ?');
  const ins = db.prepare('INSERT INTO channel_test (person_id, arm, assigned_at) VALUES (?, ?, ?)');
  let last = db.prepare('SELECT arm FROM channel_test ORDER BY assigned_at DESC, rowid DESC LIMIT 1').get()?.arm ?? 'linkedin';
  const out = [];
  for (const id of candidates) {
    if (has.get(id)) continue;
    const arm = last === 'email' ? 'linkedin' : 'email';
    ins.run(id, arm, now);
    out.push({ person_id: id, arm });
    last = arm;
  }
  return out;
}

/**
 * Who joins today: rated 4+, writable, never contacted, an address on file, at
 * a firm that could buy. A recruiter is not a pitch: the first run put one in,
 * an inbound contact already in conversation (2026-10-08).
 */
const NOT_BUYERS = new Set(['staffing', 'marketplace']);
export function candidates(db) {
  const addr = db.prepare('SELECT email, email_guess FROM people WHERE id = ?');
  const kind = db.prepare('SELECT kind FROM orgs WHERE id = ?');
  return strongWritable(db).filter((p) => p.rating >= 4 && !NOT_BUYERS.has(kind.get(p.org_id)?.kind))
    .filter((p) => { const a = addr.get(p.person_id); return Boolean(a?.email || a?.email_guess); })
    .map((p) => p.person_id);
}

/**
 * Replies by channel family, on sends at least MATURE_DAYS old. `all` is every
 * pitch on record; `test` is only people assigned an arm, by the channel they
 * were actually sent on.
 */
export function channelResults(db, { now = Date.now(), notSales = { sql: '', params: [] } } = {}) {
  ensureTable(db);
  const cutoff = new Date(now - MATURE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT o.id, o.channel, o.sent_at, ct.arm,
      EXISTS (SELECT 1 FROM responses r WHERE r.outreach_id = o.id
              AND COALESCE(r.sentiment, '') NOT IN ('accepted', 'bounced')) AS replied,
      EXISTS (SELECT 1 FROM responses r WHERE r.outreach_id = o.id AND r.sentiment = 'bounced') AS bounced
    FROM outreach o LEFT JOIN channel_test ct ON ct.person_id = o.person_id
    WHERE 1=1${notSales.sql}`).all(...notSales.params);
  const tally = (pick) => Object.fromEntries(ARMS.map((f) => {
    const xs = rows.filter((r) => pick(r) && familyOf(r.channel) === f);
    const mature = xs.filter((r) => String(r.sent_at).slice(0, 10) <= cutoff);
    return [f, { sent: xs.length, mature: mature.length,
      replied: mature.filter((r) => r.replied).length, bounced: xs.filter((r) => r.bounced).length }];
  }));
  return { all: tally(() => true), test: tally((r) => r.arm != null), matureDays: MATURE_DAYS };
}
