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

/**
 * What he has said about one person, oldest first: verdict reasons and revise notes.
 * `before` (an ISO time), for a replay: only what he had said by then, so a
 * note redrafted for comparison is not handed the corrections it is compared to.
 */
export function operatorSaid(db, personId, before = null) {
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
  // A PUBLIC EXCHANGE IS HISTORY HE NAMED. His comment on their post, and their
  // answer when he pasted it, so a note follows on from the thread instead of
  // opening cold.
  if (has(db, 'comments')) {
    const cols = db.prepare(`SELECT name FROM pragma_table_info('comments')`).all().map((c) => c.name);
    const reply = cols.includes('reply_text') ? 'reply_text, replied_at' : 'NULL AS reply_text, NULL AS replied_at';
    for (const c of db.prepare(`SELECT post_date, summary, posted_text, posted_at, replied, ${reply}
        FROM comments WHERE person_id = ? AND posted_text IS NOT NULL AND TRIM(posted_text) <> ''`).all(personId)) {
      out.push({ at: String(c.posted_at), kind: 'exchange', postDate: c.post_date, summary: c.summary,
        comment: String(c.posted_text).trim(), replied: !!c.replied,
        replyAt: c.replied_at, reply: c.reply_text ? String(c.reply_text).trim() : null });
    }
  }
  return out.filter((x) => !before || x.at < before).sort((a, b) => a.at.localeCompare(b.at));
}

function exchangeLine(x) {
  const answer = x.reply ? `; they replied${x.replyAt ? ` ${x.replyAt}` : ''}: "${x.reply}"`
    : x.replied ? '; they replied (their words not recorded)' : '; no reply recorded';
  return `- ${x.at.slice(0, 10)}, a public exchange on their LinkedIn post of ${x.postDate ?? 'unknown date'}`
    + `${x.summary ? ` (${x.summary})` : ''}: the operator commented "${x.comment}"${answer}`;
}

/** The same, as lines for a prompt; empty string when he has said nothing. */
export function operatorSaidLines(db, personId, before = null) {
  return operatorSaid(db, personId, before).map((x) => (x.kind === 'verdict'
    ? `- ${x.at.slice(0, 10)}, marked "${x.call}": "${x.said}"`
    : x.kind === 'exchange' ? exchangeLine(x)
    : `- ${x.at.slice(0, 10)}, editing an earlier ${x.channel} draft (it became v${x.version}): "${x.said}"`)).join('\n');
}

/** When he last said anything about this person, or null. */
export function operatorLastSaid(db, personId) {
  const xs = operatorSaid(db, personId);
  return xs.length ? xs[xs.length - 1].at : null;
}
