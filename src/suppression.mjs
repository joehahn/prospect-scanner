// Who is off-limits, and why.
//
// The rule this module exists to enforce (CLAUDE.md): scan never surfaces
// someone already contacted as a new prospect, and never surfaces an org
// without its prior outreach and gate history attached.
//
// Nothing here silently drops a row. Every suppressed org is still reported,
// carrying the reason, because a silent drop is indistinguishable from a bug.

/** Status precedence, most-blocking first. Lower index wins. */
const ORDER = ['KILLED', 'DNC', 'CONTACTED', 'HOLD', 'KNOWN', 'NEW'];

export function historyFor(db, orgIds) {
  if (!orgIds.length) return new Map();
  const marks = orgIds.map(() => '?').join(',');

  const rows = (sql) => db.prepare(sql).all(...orgIds);

  const outreach = rows(`
    SELECT o.org_id, o.person_id, o.channel, o.sent_at, o.service_pitched, o.status,
           o.warm, o.credit_spent, o.pitch_summary, p.name AS person_name, p.title AS person_title
    FROM outreach o LEFT JOIN people p ON p.id = o.person_id
    WHERE o.org_id IN (${marks}) ORDER BY o.sent_at DESC`);

  const gates = rows(`
    SELECT g.org_id, g.gate_id, g.outcome, g.reason, g.decided_at, p.name AS person_name
    FROM gate_results g LEFT JOIN people p ON p.id = g.person_id
    WHERE g.org_id IN (${marks}) ORDER BY g.decided_at DESC`);

  // Two IN lists, so this one needs the ids bound twice.
  const dnc = db.prepare(`
    SELECT d.org_id, d.person_id, d.reason, p.name AS person_name, p.org_id AS person_org
    FROM do_not_contact d LEFT JOIN people p ON p.id = d.person_id
    WHERE d.org_id IN (${marks}) OR p.org_id IN (${marks})`).all(...orgIds, ...orgIds);

  const holds = rows(`
    SELECT h.person_id, h.release_after, h.condition, p.name AS person_name, p.org_id
    FROM hold h JOIN people p ON p.id = h.person_id
    WHERE p.org_id IN (${marks})`);

  const people = rows(`
    SELECT id, org_id, name, title, decision_role FROM people WHERE org_id IN (${marks})`);

  const mkt = rows(
    `SELECT * FROM marketplace_registrations WHERE org_id IN (${marks})`);

  const followups = db.prepare(`
    SELECT f.date, f.note, p.name AS person_name, p.org_id
    FROM scheduled_followups f
    JOIN scheduled_followup_targets t ON t.followup_id = f.id
    JOIN people p ON p.id = t.person_id
    WHERE p.org_id IN (${marks}) ORDER BY f.date`).all(...orgIds);

  const map = new Map(orgIds.map((id) => [id, {
    org_id: id, outreach: [], gates: [], dnc: [], holds: [], people: [],
    marketplace: [], followups: [],
  }]));
  const push = (key, list, orgKey = 'org_id') => {
    for (const r of list) {
      const entry = map.get(r[orgKey] ?? r.person_org);
      if (entry) entry[key].push(r);
    }
  };
  push('outreach', outreach);
  push('gates', gates);
  push('people', people);
  push('marketplace', mkt);
  push('holds', holds);
  push('followups', followups);
  for (const d of dnc) {
    const entry = map.get(d.org_id ?? d.person_org);
    if (entry) entry.dnc.push(d);
  }
  return map;
}

/**
 * Classify an org against its history. `today` is passed in so the same
 * database yields the same answer regardless of when the report is re-run.
 */
export function classify(history, today) {
  const reasons = [];
  let status = 'NEW';
  const at = (s) => { if (ORDER.indexOf(s) < ORDER.indexOf(status)) status = s; };

  const kills = history.gates.filter((g) => g.outcome === 'kill' || g.outcome === 'kill_as_buyer');
  const warns = history.gates.filter((g) => g.outcome === 'warn');
  if (kills.length) {
    at('KILLED');
    for (const k of kills) {
      reasons.push(`${k.gate_id} ${k.outcome === 'kill_as_buyer' ? 'kill (as buyer; keep as referral node)' : 'kill'}` +
        `${k.decided_at ? ` ${k.decided_at}` : ''}: ${k.reason ?? ''}`.trimEnd());
    }
  }

  const orgDnc = history.dnc.filter((d) => d.org_id && !d.person_id);
  if (orgDnc.length) { at('DNC'); for (const d of orgDnc) reasons.push(`do-not-contact (firm): ${d.reason}`); }

  if (history.outreach.length) {
    at('CONTACTED');
    const last = history.outreach[0];
    reasons.push(`${history.outreach.length} prior outreach, last ${last.sent_at} ` +
      `${last.channel} to ${last.person_name ?? last.person_id ?? 'unknown'} (${last.status ?? 'no status'})`);
  }

  const liveHolds = history.holds.filter((h) => h.release_after > today);
  if (liveHolds.length) {
    at('HOLD');
    for (const h of liveHolds) {
      reasons.push(`${h.person_name} held until ${h.release_after}: ${h.condition ?? ''}`.trimEnd());
    }
  }

  if (status === 'NEW' && (history.people.length || history.gates.length)) at('KNOWN');

  for (const w of warns) reasons.push(`${w.gate_id} warn: ${w.reason ?? ''}`.trimEnd());

  const personDnc = history.dnc.filter((d) => d.person_id);
  for (const d of personDnc) reasons.push(`do-not-contact: ${d.person_name ?? d.person_id} — ${d.reason}`);

  const released = history.holds.filter((h) => h.release_after <= today);
  for (const h of released) {
    reasons.push(`hold RELEASED ${h.release_after}: ${h.person_name} — ${h.condition ?? ''}`.trimEnd());
  }

  // The note belongs to the batch, not to any one person, so group by date
  // rather than repeating it under each name.
  const byDate = new Map();
  for (const f of history.followups) {
    if (!byDate.has(f.date)) byDate.set(f.date, { names: [], note: f.note });
    byDate.get(f.date).names.push(f.person_name);
  }
  for (const [date, f] of byDate) {
    reasons.push(`follow-up due ${date}: ${f.names.join(', ')}${f.note ? ` — ${f.note}` : ''}`);
  }

  return { status, reasons, contactable: status === 'NEW' || status === 'KNOWN' };
}

/** People at an org who are not suppressed, i.e. who could still be approached. */
export function openContacts(history, today) {
  const blocked = new Set(history.dnc.filter((d) => d.person_id).map((d) => d.person_id));
  const held = new Set(history.holds.filter((h) => h.release_after > today).map((h) => h.person_id));
  const contacted = new Set(history.outreach.map((o) => o.person_id));
  return history.people.filter(
    (p) => !blocked.has(p.id) && !held.has(p.id) && !contacted.has(p.id));
}
