// Whether a pasted profile shows its owner recruiting for the skill sold.

/**
 * A HIRING QUOTE IS A FACT ABOUT THE PAGE, SO CHECK IT AGAINST THE PAGE. Added
 * 2026-10-02. hiring_for_capability blocks a person from the capacity offer, and
 * the cheap model filled it for 147 of 339 profiles on its first full pass:
 * a bare "|", "+null", a note about its own reasoning, a recruiter's bio, a
 * talk title, a new-job announcement. A prompt is a request; this is the
 * control. The quote must say someone is hiring, name the capability sold, and
 * some stretch of it must appear on the pasted page word for word.
 */
const HIRING_CUE = /\b(hiring|we'?re hiring|join (?:us|my|our|the) team|come (?:join|work|be a part)|looking for (?:an?|our|two|three|several)|recruiting|open (?:role|position|req)s?|positions? (?:available|open)|now accepting applications|apply (?:here|now|today)|grow(?:ing)? (?:my|our|the) team)\b/i;
export function hiringQuote(quote, page, terms = []) {
  const q = String(quote ?? '').trim();
  if (!q || !HIRING_CUE.test(q)) return null;
  if (terms.length && !terms.some((t) => t.test(q))) return null;
  const norm = (x) => String(x).toLowerCase().replace(/[\u2018\u2019\u201c\u201d"'`]/g, '').replace(/\s+/g, ' ').trim();
  const hay = norm(page);
  const pieces = q.split(/\.\.\.|\u2026|" *[-;,] *"|\(from [^)]*\)/).map(norm).filter((x) => x.length >= 20);
  return pieces.some((x) => hay.includes(x.slice(0, 120))) ? q : null;
}

// THE CAPABILITY, IN WORDS A JOB POST USES. Taken from the gates'
// capability_titles in config, so another business's titles give its own
// words: "Head of AI" and "Data Science Director" give AI, data, science.
// Seat words that every job title carries are not evidence of anything.
const SEAT = new Set(['head', 'director', 'of', 'the', 'and', 'chief', 'officer', 'vp', 'vice',
  'president', 'senior', 'lead', 'manager', 'operating', 'partner', 'principal', 'global', 'svp', 'evp']);
export function capabilityTerms(titles = []) {
  const words = new Set(titles.flatMap((t) => String(t).toLowerCase().split(/[^a-z0-9]+/))
    .filter((w) => w.length >= 2 && !SEAT.has(w)));
  // "data-driven initiatives" is not a data role: a word used as a modifier for
  // -driven/-informed/-backed does not name the capability. Added 2026-10-02,
  // when a repost of programmer-analyst openings blocked a deputy CIO.
  const notModifier = '(?![- ]?(?:driven|informed|backed|centric|first)\\b)';
  return [...words].map((w) => (w.length >= 6
    ? new RegExp(`\\b${w.slice(0, -2)}\\w*${notModifier}`, 'i')
    : new RegExp(`\\b${w}\\b${notModifier}`, 'i')));
}
