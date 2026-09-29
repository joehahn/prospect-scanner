// Loads data/seed-outreach.json into the database.
//
// This file is the operator's existing outreach history, and in this system it
// is the suppression list. Scan must never surface someone already contacted as
// a new prospect, and must never surface an org without its prior outreach and
// gate history attached. That is only possible if this loads first.
//
// Idempotent: every row it writes carries seeded = 1, and a re-run replaces
// exactly those rows and nothing a pipeline stage wrote.
//
// Note on evidence: none of this becomes `evidence`. Evidence rows require a
// retrievable source_url (CLAUDE.md), and operator memory has none. Recording
// it as evidence would let a dossier cite a recollection as if it were a link.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, startRun, finishRun } from './db.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SEED_PATH = resolve(ROOT, 'data/seed-outreach.json');

const bool = (v) => (v === undefined || v === null ? null : v ? 1 : 0);

export function loadSeed(db, path = SEED_PATH, { quiet = false } = {}) {
  if (!existsSync(path)) return { skipped: `no seed file at ${path}` };
  const seed = JSON.parse(readFileSync(path, 'utf8'));
  const say = (...a) => { if (!quiet) console.log(...a); };

  const runId = startRun(db, 'seed', { notes: path });
  const counts = {};

  db.transaction(() => {
    // ROWS THIS LOADER DOES NOT OWN CAN POINT AT ROWS IT DOES, and the
    // delete-then-reinsert below hands every seeded outreach row a NEW
    // autoincrement id. Anything referencing the old id is then either a
    // foreign-key failure or, worse, a silent mis-pointer.
    //
    // Found 2026-09-25: `npm run scan` could not start at all, because it calls
    // loadSeed on boot and the DELETE FROM outreach hit "FOREIGN KEY constraint
    // failed". One `responses` row pointed at a seeded outreach -- the MISROUTED
    // reply from a Director of Talent that is the whole reason every note now
    // carries "Am not applying for a job". The seed file has NO responses
    // section and this loader never writes that table, so deleting it would
    // have destroyed a record nothing could restore. The constraint was
    // protecting real data, not obstructing the loader.
    //
    // So: remember what each dependent was attached to by the outreach's
    // NATURAL key -- (org_id, person_id, channel, sent_at), which is stable
    // across reloads because it comes from the seed file -- and re-point them
    // once the rows exist again. `drafts` is here for the same reason:
    // `lead -- sent` pairs a draft to its outreach row, and that pairing is the
    // draft/sent diff the voice stage learns from.
    const carried = [];
    for (const [tbl] of [['responses'], ['drafts']]) {
      for (const r of db.prepare(`
        SELECT d.id, o.org_id, o.person_id, o.channel, o.sent_at
          FROM ${tbl} d JOIN outreach o ON o.id = d.outreach_id
         WHERE o.seeded = 1`).all()) {
        carried.push({ tbl, ...r });
      }
    }
    // Detach before the delete so the constraint is satisfied; re-attach below.
    // NOT NULL on responses.outreach_id means detaching is not an option there,
    // so those rows move to a sentinel-free path: they are deleted and restored
    // from the snapshot instead.
    const savedResponses = db.prepare(`
      SELECT r.*, o.org_id, o.person_id, o.channel, o.sent_at
        FROM responses r JOIN outreach o ON o.id = r.outreach_id
       WHERE o.seeded = 1`).all();
    db.prepare('UPDATE drafts SET outreach_id = NULL WHERE outreach_id IN '
      + '(SELECT id FROM outreach WHERE seeded = 1)').run();
    db.prepare('DELETE FROM responses WHERE outreach_id IN '
      + '(SELECT id FROM outreach WHERE seeded = 1)').run();

    // Clear only seed-owned rows, oldest-dependency-last.
    db.prepare(`DELETE FROM scheduled_followup_targets WHERE followup_id IN
                (SELECT id FROM scheduled_followups WHERE seeded = 1)`).run();
    for (const t of ['scheduled_followups', 'hold', 'do_not_contact',
                     'marketplace_registrations', 'gate_results', 'outreach']) {
      db.prepare(`DELETE FROM ${t} WHERE seeded = 1`).run();
    }

    const org = db.prepare(`
      INSERT INTO orgs (id, name, domain, industry, headcount_est, hq, aum_usd,
                        first_seen, source, seeded)
      VALUES (@id, @name, @domain, @industry, @headcount_est, @hq, @aum_usd,
              @first_seen, @source, 1)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, domain = excluded.domain, industry = excluded.industry,
        headcount_est = COALESCE(excluded.headcount_est, orgs.headcount_est),
        hq = COALESCE(excluded.hq, orgs.hq), aum_usd = COALESCE(excluded.aum_usd, orgs.aum_usd),
        -- first_seen is the earliest sighting, so the seed never pushes it later
        first_seen = MIN(orgs.first_seen, excluded.first_seen),
        seeded = 1`);
    for (const o of seed.orgs ?? []) {
      org.run({
        id: o.id, name: o.name, domain: o.domain ?? null, industry: o.industry ?? null,
        headcount_est: o.headcount_est ?? null, hq: o.hq ?? null, aum_usd: o.aum_usd ?? null,
        first_seen: o.first_seen ?? seed.generated_at, source: o.source ?? 'seed-outreach.json',
      });
    }
    counts.orgs = (seed.orgs ?? []).length;

    const person = db.prepare(`
      INSERT INTO people (id, org_id, name, title, decision_role, profile_url,
                          notes, degree, email, email_guess)
      VALUES (@id, @org_id, @name, @title, @decision_role, @profile_url,
              @notes, @degree, @email, @email_guess)
      ON CONFLICT(id) DO UPDATE SET
        org_id = excluded.org_id, name = excluded.name, title = excluded.title,
        decision_role = excluded.decision_role, profile_url = excluded.profile_url,
        notes = excluded.notes, degree = excluded.degree,
        email = excluded.email, email_guess = excluded.email_guess`);
    for (const p of seed.people ?? []) {
      person.run({
        id: p.id, org_id: p.org_id, name: p.name, title: p.title ?? null,
        decision_role: p.decision_role ?? null, profile_url: p.profile_url ?? null,
        notes: p.notes ?? null, degree: p.degree ?? null,
        email: p.email ?? null, email_guess: p.email_guess ?? null,
      });
    }
    counts.people = (seed.people ?? []).length;

    const out = db.prepare(`
      INSERT INTO outreach (org_id, person_id, channel, sent_at, service_pitched,
                            message_text, subject, pitch_summary, status, warm,
                            credit_spent, rate_usd_hour_quoted, source_memory, seeded)
      VALUES (@org_id, @person_id, @channel, @sent_at, @service_pitched,
              @message_text, @subject, @pitch_summary, @status, @warm,
              @credit_spent, @rate, @source_memory, 1)`);
    for (const o of seed.outreach ?? []) {
      out.run({
        org_id: o.org_id, person_id: o.person_id ?? null, channel: o.channel,
        sent_at: o.sent_at, service_pitched: o.service_pitched ?? null,
        message_text: o.message_text ?? null, subject: o.subject ?? null,
        pitch_summary: o.pitch_summary ?? null, status: o.status ?? null,
        warm: bool(o.warm), credit_spent: bool(o.credit_spent),
        rate: o.rate_quoted_usd_hour ?? null, source_memory: o.source_memory ?? null,
      });
    }
    counts.outreach = (seed.outreach ?? []).length;

    // RE-POINT WHAT WAS CARRIED. See the note at the top of this transaction.
    // A dependent whose outreach row is no longer in the seed file cannot be
    // re-pointed; it is reported rather than dropped silently, because a reply
    // that loses its note is exactly the kind of loss nobody notices.
    const findOutreach = db.prepare(`SELECT id FROM outreach
       WHERE org_id = @org_id AND channel = @channel AND sent_at = @sent_at
         AND person_id IS @person_id AND seeded = 1 LIMIT 1`);
    const orphaned = [];
    for (const r of savedResponses) {
      const now = findOutreach.get(r);
      if (!now) { orphaned.push(`response #${r.id} (${r.responded_at})`); continue; }
      db.prepare(`INSERT INTO responses (id, outreach_id, responded_at, sentiment, outcome, notes)
                  VALUES (@id, @oid, @responded_at, @sentiment, @outcome, @notes)`)
        .run({ id: r.id, oid: now.id, responded_at: r.responded_at,
               sentiment: r.sentiment, outcome: r.outcome, notes: r.notes });
    }
    for (const c of carried.filter((x) => x.tbl === 'drafts')) {
      const now = findOutreach.get(c);
      if (!now) { orphaned.push(`draft #${c.id}`); continue; }
      db.prepare('UPDATE drafts SET outreach_id = ? WHERE id = ?').run(now.id, c.id);
    }
    if (orphaned.length) {
      say(`  WARNING: ${orphaned.length} row(s) referenced a seeded outreach that is no `
        + `longer in the seed file and could not be re-pointed: ${orphaned.join(', ')}`);
    }

    const gate = db.prepare(`
      INSERT INTO gate_results (org_id, person_id, gate_id, outcome, reason, decided_at, seeded)
      VALUES (@org_id, @person_id, @gate_id, @outcome, @reason, @decided_at, 1)`);
    for (const g of seed.gate_results ?? []) {
      gate.run({
        org_id: g.org_id, person_id: g.person_id ?? null, gate_id: g.gate_id,
        outcome: g.outcome, reason: g.reason ?? null, decided_at: g.decided_at ?? null,
      });
    }
    counts.gate_results = (seed.gate_results ?? []).length;

    const dnc = db.prepare(
      'INSERT INTO do_not_contact (person_id, org_id, reason, seeded) VALUES (?, ?, ?, 1)');
    for (const d of seed.do_not_contact ?? []) {
      dnc.run(d.person_id ?? null, d.org_id ?? null, d.reason);
    }
    counts.do_not_contact = (seed.do_not_contact ?? []).length;

    const hold = db.prepare(
      'INSERT INTO hold (person_id, release_after, condition, seeded) VALUES (?, ?, ?, 1)');
    for (const h of seed.hold ?? []) hold.run(h.person_id, h.release_after, h.condition ?? null);
    counts.hold = (seed.hold ?? []).length;

    const mkt = db.prepare(`
      INSERT INTO marketplace_registrations (org_id, joined_at, applied_at, rate_usd_hour,
                                             rate_usd_hour_net, pitches_submitted, last_pitch,
                                             outcome, note, seeded)
      VALUES (@org_id, @joined_at, @applied_at, @rate_usd_hour, @rate_usd_hour_net,
              @pitches_submitted, @last_pitch, @outcome, @note, 1)`);
    for (const m of seed.marketplace_registrations ?? []) {
      mkt.run({
        org_id: m.org_id, joined_at: m.joined_at ?? null, applied_at: m.applied_at ?? null,
        rate_usd_hour: m.rate_usd_hour != null ? String(m.rate_usd_hour) : null,
        rate_usd_hour_net: m.rate_usd_hour_net ?? null,
        pitches_submitted: m.pitches_submitted ?? null, last_pitch: m.last_pitch ?? null,
        outcome: m.outcome ?? null, note: m.note ?? null,
      });
    }
    counts.marketplace_registrations = (seed.marketplace_registrations ?? []).length;

    const fu = db.prepare('INSERT INTO scheduled_followups (date, note, seeded) VALUES (?, ?, 1)');
    const fuT = db.prepare(
      'INSERT OR IGNORE INTO scheduled_followup_targets (followup_id, person_id) VALUES (?, ?)');
    for (const f of seed.scheduled_followups ?? []) {
      const fid = fu.run(f.date, f.note ?? null).lastInsertRowid;
      for (const pid of f.person_ids ?? []) fuT.run(fid, pid);
    }
    counts.scheduled_followups = (seed.scheduled_followups ?? []).length;
  })();

  finishRun(db, runId, { n_in: counts.orgs, n_out: counts.people });

  say(`seed: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  if (seed.channel_rules?.length && !quiet) {
    say('\nchannel rules carried in from the seed (these bind every stage downstream):');
    for (const r of seed.channel_rules) say(`  · ${r}`);
  }
  return counts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  loadSeed(db);
  db.close();
}
