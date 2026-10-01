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
export function noteOnly(body) {
  const cut = String(body ?? '').split(/^NOTES\s*$/m)[0];
  const stripped = cut.replace(/^\s*DRAFT\s*\n-+\s*\n/m, '').trim();
  // Older drafts predate the DRAFT/NOTES convention; if splitting leaves almost
  // nothing, the row has no separable note and the whole body is the best answer.
  return stripped.length > 40 ? stripped : String(body ?? '').trim();
}
