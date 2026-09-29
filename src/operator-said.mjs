// What the operator has said about a person, in his own words.
//
// Added 2026-09-27. His verdicts carry a reason ("sell extra hands to him and
// his team to push his AI agents and use cases to production faster"), and
// until now only the judge read them. The read, left to the profile, decided the
// same person was alone with nothing started and pitched a first-pilot hour;
// the drafter followed it. What he knows first-hand is the best evidence on
// file about what someone is doing and what to offer them, so the read and the
// drafter get it, dated and marked as his.

// Also his REVISE INSTRUCTIONS on earlier drafts to the same person (added the
// same day, at his request). They often carry what he knows about the person
// ("he already has teams of engineers, so that is not compelling"), and a
// later draft or follow-up that forgets them repeats the mistake he corrected.
// They are marked as edits to an earlier draft, because some are about wording
// that draft used rather than about the person.

const has = (db, t) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);

/** What he has said about one person, oldest first: verdict reasons and revise notes. */
export function operatorSaid(db, personId) {
  const out = [];
  if (has(db, 'verdicts')) {
    for (const v of db.prepare(`SELECT verdict, first, reason, created_at FROM verdicts
        WHERE person_id = ? AND reason IS NOT NULL AND TRIM(reason) <> ''`).all(personId)) {
      out.push({ at: String(v.created_at), kind: 'verdict',
        call: v.first ? 'write first' : v.verdict === 'write' ? 'would write' : 'would not write',
        said: String(v.reason).trim() });
    }
  }
  if (has(db, 'drafts')) {
    for (const r of db.prepare(`SELECT version, channel, revise_note, created_at FROM drafts
        WHERE person_id = ? AND revise_note IS NOT NULL AND TRIM(revise_note) <> ''`).all(personId)) {
      out.push({ at: String(r.created_at), kind: 'revise', version: r.version, channel: r.channel,
        said: String(r.revise_note).trim() });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** The same, as lines for a prompt; empty string when he has said nothing. */
export function operatorSaidLines(db, personId) {
  return operatorSaid(db, personId).map((x) => (x.kind === 'verdict'
    ? `- ${x.at.slice(0, 10)}, marked "${x.call}": "${x.said}"`
    : `- ${x.at.slice(0, 10)}, editing an earlier ${x.channel} draft (it became v${x.version}): "${x.said}"`)).join('\n');
}

/** When he last said anything about this person, or null. */
export function operatorLastSaid(db, personId) {
  const xs = operatorSaid(db, personId);
  return xs.length ? xs[xs.length - 1].at : null;
}
