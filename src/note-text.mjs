// The part of a stored draft the recipient would read. Shared by `dash` and
// `grade`, so a grade and a card measure the same text.

/**
 * The note alone, without the NOTES section the drafter writes for the operator.
 *
 * Comparing a stored draft to what was sent means comparing the part the
 * RECIPIENT would read. Measuring the whole row instead reported a 764-character
 * send against a 3,846-character draft — an 80% cut — when the note inside it
 * was 956 characters and the real cut was 20%. The conclusion drawn from that
 * number, that the drafter runs three to six times too long, was an artifact of
 * counting the operator's own briefing notes as if they were the letter.
 */
// The heading as the drafter writes it, and as it sometimes writes it instead:
// bold (**DRAFT**), or left out altogether. Six drafts in the week to
// 2026-10-07 had one of the variants.
const HEADING = /^\s*\**DRAFT\**\s*\n-+\s*\n/m;

export function noteOnly(body) {
  const cut = String(body ?? '').split(/^NOTES\s*$/m)[0];
  const stripped = cut.replace(HEADING, '').trim();
  // Older drafts predate the DRAFT/NOTES convention; if splitting leaves almost
  // nothing, the row has no separable note and the whole body is the best answer.
  return stripped.length > 40 ? stripped : String(body ?? '').trim();
}

/**
 * A drafter that declines writes only its reasons, under NOTES, with no note
 * above them. Asked by the TEXT, not the heading: a note that came back without
 * its DRAFT heading was shown as a refusal on 2026-10-07, its box left empty, on
 * a card the operator then sent from.
 */
export function isDeclined(body) {
  const b = String(body ?? '');
  if (!/^\s*NOTES\s*$/m.test(b)) return false;
  const note = b.split(/^NOTES\s*$/m)[0].replace(HEADING, '').trim();
  // ...or says so in prose in place of the note ("I should not draft this note").
  return note.length <= 40 || /\b(should not|shouldn't|will not|won't|cannot|can't) draft\b/i.test(note);
}
