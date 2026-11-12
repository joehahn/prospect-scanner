// What is wrong with the text about to be recorded as sent: the note the
// operator actually pasted, after his own edits, not the draft.
//
// WHY (2026-11-12). Every check in this project ran on the DRAFT, and nothing
// on what went out. An outside review of the sent history found, and the
// database confirms:
//   - a note sent with the drafter's internal NOTES section in it ("My read on
//     whether to send... Expect a polite reply at best");
//   - a note to one county CIO naming another county;
//   - "HiHi", "fit possibly fit", "I take can take" from hand edits.
// The operator pastes and sends by hand, so recording is the one moment the
// system sees the final text. No model: these are plain patterns, measured
// against the sent history before they were turned on (test/send-check.test.mjs).
//
// A finding refuses the record with the reason; `--checked` records anyway.

const INTERNAL = [
  [/^\s*(NOTES|STORYLINE|DRAFT|OFFER|SUBJECT)\s*$/m, 'contains a section heading from the drafter\'s output'],
  [/^\s*-{4,}\s*$/m, 'contains a divider line from the drafter\'s output'],
  [/\bmy (honest )?read on (whether|sending)\b/i, 'contains the drafter\'s private read on sending'],
  [/\b(STORYLINE|Storyline|DO NOT SAY)\b/, 'contains the drafter\'s internal vocabulary'],
  [/\bv\d{2}\b(?![\d.])/, 'mentions a prompt version number (like v38)'],
];

const STOP = new Set(['that', 'had', 'is', 'very', 'so', 'bye', 'no', 'yes', 'ha', 'hey', 'really', 'many', 'long', 'far']);

/** Places a note names as a county, city, town or state. */
function placesNamed(text) {
  const out = new Set();
  for (const m of text.matchAll(/\b(?:County|City|Town|State) of ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/g)) out.add(m[1]);
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)?) County\b/g)) out.add(m[1]);
  return [...out];
}

/**
 * Problems with a note about to be recorded as sent, as plain sentences.
 * @param text      the note as pasted
 * @param person    { name } of the recipient
 * @param orgName   the recipient's firm on file
 */
export function sendProblems(text, { person = null, orgName = null } = {}) {
  const t = String(text ?? '');
  const out = [];
  for (const [re, why] of INTERNAL) if (re.test(t)) out.push(`It ${why}.`);

  for (const m of t.matchAll(/\b([A-Za-z]+)\s+\1\b/gi)) {
    if (!STOP.has(m[1].toLowerCase())) out.push(`"${m[0]}": a word typed twice.`);
  }
  for (const m of t.matchAll(/\b([A-Z][a-z]{1,})\1\b/g)) out.push(`"${m[0]}": a word typed twice.`);

  if (orgName) {
    const org = String(orgName).toLowerCase();
    for (const place of placesNamed(t)) {
      if (!org.includes(place.toLowerCase())) {
        out.push(`It names "${place}" as a county, city or state, and the firm on file is ${orgName}.`);
      }
    }
  }

  if (person?.name) {
    const greet = t.match(/^\s*(?:Hi|Hello|Dear|Hey)\s+(?:(?:Dr|Mr|Mrs|Ms|Prof)\.?\s+)?([A-Z][\w'-]+)/);
    if (greet) {
      const parts = String(person.name).toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean);
      const g = greet[1].toLowerCase();
      if (!parts.some((p) => p === g || p.startsWith(g) || g.startsWith(p))) {
        out.push(`It greets "${greet[1]}", and the card is ${person.name}.`);
      }
    }
  }
  return [...new Set(out)];
}
