import * as greenhouse from './greenhouse.mjs';
import * as ashby from './ashby.mjs';
import * as lever from './lever.mjs';

export const SOURCES = { greenhouse, ashby, lever };

/**
 * Board-token guesses for an org. None of the three ATSs offers a lookup by
 * company name, so `scan --discover` probes these and keeps what answers.
 */
// A TOKEN THAT COULD BELONG TO ANYONE WILL BELONG TO SOMEONE ELSE. Board tokens
// are first-come registrations on a shared namespace, so a guess that is a
// common English word or a three-letter string resolves to whichever company
// claimed it -- not to the firm being probed.
//
// Measured 2026-09-25, the first time --discover ever ran: of five boards it
// found, THREE were the wrong company.
//   greenhouse/insurance -> claimed as an insurer in the book,
//                           actually an insurance consultancy
//   ashby/<first word>   -> claimed as the same insurer,
//                           actually a seed-stage AI startup sharing the word
//   ashby/<short name>   -> claimed as a sports data firm in the book,
//                           actually a collectibles asset platform
// Left alone, the first would have written a consultancy's "Insurance Data &
// Analytics Lead" posting as a hiring_req trigger on a real prospect, sourced
// to a URL that does not describe them.
const GENERIC_TOKENS = new Set([
  'insurance', 'capital', 'partners', 'group', 'holdings', 'global', 'digital',
  'financial', 'medical', 'health', 'data', 'bank', 'ventures', 'advisors',
  'technologies', 'solutions', 'systems', 'services', 'careers', 'jobs', 'www',
  'us', 'usa', 'uk', 'corp', 'international', 'american', 'national', 'first',
]);

// Two-label public suffixes, so "acme.co.uk" yields "acme" rather than "co".
const TWO_PART_SUFFIX = new Set(['co.uk', 'com.au', 'co.nz', 'co.za', 'com.br',
  'co.jp', 'co.in', 'com.mx', 'co.il', 'com.sg']);

/** The registrable label of a domain: the one that identifies the company. */
function registrableLabel(domain) {
  const host = String(domain).replace(/^https?:\/\//, '').split('/')[0]
    .replace(/^www\./, '').toLowerCase();
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return parts[0] ?? '';
  const lastTwo = parts.slice(-2).join('.');
  // SUBDOMAINS ARE NOT THE COMPANY. "insurance.archgroup.com" identifies the
  // company as "archgroup"; the first label is a business unit.
  return TWO_PART_SUFFIX.has(lastTwo) ? (parts[parts.length - 3] ?? '') : parts[parts.length - 2];
}

export function candidateTokens({ name, domain }) {
  const out = new Set();
  // A token shorter than four characters is almost always someone else's.
  // "alt" and "arch" both were.
  const add = (s) => {
    if (!s || !/^[a-z0-9-]{4,40}$/.test(s)) return;
    if (GENERIC_TOKENS.has(s)) return;
    out.add(s);
  };

  if (domain) add(registrableLabel(domain));
  if (name) {
    const words = String(name).toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !['the', 'inc', 'llc', 'ltd', 'corp', 'group', 'co', 'company'].includes(w));
    add(words.join(''));
    add(words.join('-'));
    // THE FIRST WORD ALONE IS THE WEAKEST GUESS and produced two of the three
    // wrong boards. Kept only when it is distinctive enough to be worth a probe:
    // a single short word is exactly the kind another company already owns.
    if (words.length > 1 && words[0].length >= 6) add(words[0]);
  }
  return [...out];
}
