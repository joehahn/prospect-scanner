// Deterministic checks over a drafted note. No model, no cost, no judgement.
//
// WHY THESE ARE SEPARATE FROM THE JUDGE. `audit` asks a model to read each note
// and name what is wrong with it, which is the only way to catch "this is
// generic" or "this recites his own profile back at him". It costs about three
// cents a note and it is NOT REPRODUCIBLE: re-running the judge on an unchanged
// corpus moved a flag by three. The operator's own rule, written after watching
// that happen: a single run is not a measurement.
//
// Everything in this file is the opposite. It is arithmetic over the text, so
// it returns the same answer every time, it costs nothing, and it can run over
// every draft in the book in under a second. That makes it the right place for
// any defect that can be stated mechanically -- and most of the ones found by
// hand this week could be.
//
// ONE DEFINITION, TWO CALLERS. `draft` runs these as a gate on a single note at
// the moment it is written; `audit` runs the identical functions across the
// whole corpus to count them. Before this file existed the recipe control lived
// inline in draft.mjs, which meant the census and the gate could disagree about
// what "off the recipe" meant -- two places to keep in sync, which is how they
// drift apart.

/** Strip the dossier furniture, leaving what the recipient would actually read. */
export function noteBody(raw) {
  const body = String(raw ?? '').split(/^NOTES\s*$/m)[0]
    .replace(/^\s*DRAFT\s*\n-+\s*\n/m, '')
    .replace(/^\s*SUBJECT\s*\n-+\s*\n[\s\S]*?\n\s*\n/m, '');
  return body.trim();
}

/** The prose after the salutation: the part the beats are measured over. */
export function prose(raw) {
  const body = noteBody(raw);
  const sal = (body.match(/^\s*(?:Greetings|Hi|Hello|Howdy|Dear)[^\n]*/mi) ?? [''])[0];
  return body.slice(body.indexOf(sal) + sal.length).trim();
}

// The bridge is a first-person claim about what he does or sells. Held as a
// family of phrasings rather than one string, because a fixed sentence is how
// six notes in one batch came back with identical middle paragraphs.
export const BRIDGE = /(is what I do|what I sell is|that is what I sell|is what I build|is the next piece|is one of the many things I do|and that is what I|which is what I)/i;

const NOISE = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'your', 'you',
  'for', 'are', 'has', 'have', 'was', 'were', 'not', 'but', 'its', 'their', 'they']);

/**
 * Every mechanical flag for one note.
 *
 * `evidenceText` is everything on file about the firm and the person, claims and
 * bodies together. Beat 1 says the opener is "drawn from the evidence", so that
 * is what gets tested -- not whether the sentence contains the word "you". An
 * earlier version tested for a second person and passed the note that prompted
 * the whole check: "Size is the half of growth YOU can plan for" is a maxim with
 * a pronoun in it, which is exactly the trick.
 */
export function checkNote({ raw, person = {}, org = {}, evidenceText = '', hasRead = true }) {
  const p = prose(raw);
  const flags = [];
  if (!p) return [{ flag: 'empty', detail: 'no prose after the salutation' }];

  const opener = (p.split(/(?<=[.?!])\s/)[0] ?? '').trim();

  const evWords = new Set();
  for (const w of `${evidenceText} ${org.name ?? ''} ${person.name ?? ''}`
    .toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) ?? []) {
    if (!NOISE.has(w)) evWords.add(w);
  }
  const openerWords = (opener.toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) ?? [])
    .filter((w) => !NOISE.has(w));
  if (openerWords.length && !openerWords.some((w) => evWords.has(w))) {
    flags.push({ flag: 'aphorism-opener', detail: opener.slice(0, 96) });
  }

  const at = p.search(BRIDGE);
  if (at < 0) {
    flags.push({ flag: 'no-bridge', detail: 'nothing says flatly that this is what he does' });
  } else if (at / p.length > 0.55) {
    flags.push({ flag: 'late-bridge', detail: `bridge at ${Math.round(100 * at / p.length)}%` });
  }

  // WRONG RECIPIENT IS UNRECOVERABLE, which is why it is a check and not a note
  // in a prompt: a note to a CFO once came back addressed to his CTO.
  //
  // ANY PART OF THEIR NAME COUNTS, not just the first. Testing the first name
  // alone flagged two correct notes on 2026-09-25 -- "Greetings Judge Peters,"
  // to an elected county judge and "Greetings Dr. Lowery-Hart," to a college
  // chancellor. An honorific plus surname is how people are addressed, and a
  // check that cries wolf on it trains the operator to ignore the one flag that
  // must never be ignored.
  const parts = String(person.name ?? '').trim().split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z'-]/g, ''))
    .filter((w) => w.length > 1 && !/^(dr|mr|mrs|ms|prof|judge|sir|rev)$/i.test(w));
  const sal = (noteBody(raw).match(/^\s*(?:Greetings|Hi|Hello|Howdy|Dear)[^\n]*/mi) ?? [''])[0];
  const named = parts.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(sal));
  if (parts.length && sal && !named) {
    flags.push({ flag: 'wrong-recipient', detail: sal.trim().slice(0, 60) });
  }

  // The ceiling he keeps pulling drafts back to. voice.md: "Notes come back
  // shorter, never longer."
  const words = p.split(/\s+/).filter(Boolean).length;
  if (words > 160) flags.push({ flag: 'too-long', detail: `${words} words` });

  // A note written with no thesis has nothing to connect its facts to. 30 of 48
  // drafted people had no read, because the dashboard button never ran one.
  if (!hasRead) flags.push({ flag: 'no-read', detail: 'drafted with no thesis on file' });

  return flags;
}

export const MECHANICAL_FLAGS = ['empty', 'aphorism-opener', 'no-bridge', 'late-bridge',
  'wrong-recipient', 'too-long', 'no-read'];
