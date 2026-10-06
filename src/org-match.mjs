// Does a title name an organisation other than the one a person is filed at?
//
// Used when a pasted profile's "People also viewed" sidebar names people: each
// is filed at the pasted person's organisation unless their own title says
// otherwise. Pure functions, so the rule can be tested.

// WORDS THAT DO NOT TELL ONE ORGANISATION FROM ANOTHER. A state's Department of
// Transportation and its Department of Motor Vehicles share the state's name and
// "department", and a check that counted any shared word filed two other
// agencies' CIOs, off one DMV profile's sidebar, as DMV staff (2026-10-06).
const GENERIC_ORG_WORDS = new Set(['department', 'dept', 'state', 'city', 'county', 'town', 'village',
  'office', 'agency', 'division', 'commission', 'authority', 'board', 'bureau', 'administration',
  'services', 'service', 'public', 'government', 'national', 'federal', 'united', 'states', 'america',
  'american', 'company', 'companies', 'group', 'holdings', 'partners', 'capital', 'international',
  'global', 'north', 'south', 'east', 'west', 'new',
  // A state's name is shared by every agency in it.
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
  'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky',
  'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'hampshire', 'jersey', 'mexico', 'york', 'carolina',
  'dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode', 'island', 'tennessee', 'texas',
  'utah', 'vermont', 'virginia', 'washington', 'wisconsin', 'wyoming', 'commonwealth']);

/** An organisation name's words that identify it: long enough, and not generic. */
export function distinctWords(name) {
  const all = String(name ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
  const own = all.filter((w) => !GENERIC_ORG_WORDS.has(w));
  return own.length ? own : all;
}

/**
 * The other organisation a title names, or null when it names none or names
 * this one: ` @ ` and ` at ` forms, civic bodies ("City of X"), and agencies
 * ("Vermont Department of Transportation", "Department of Public Safety").
 *
 * `of` alone is not a signal: it caught "Head of Product" and would have
 * silently dropped a real colleague, which is the worse error. A missed block
 * leaves someone filed at the wrong firm where a human can see and move them;
 * a false block loses them without a trace.
 */
export function otherOrgInTitle(title, orgName) {
  const t = String(title ?? '');
  const m = t.match(/(?:\s@\s*|\sat\s+)([A-Z][\w&.,' -]{2,40})/)
    ?? t.match(/\b((?:City|County|Town|Village|Borough|District) of [A-Z][\w' -]{2,30})/)
    ?? t.match(/\b((?:[A-Z][\w&']+ )*(?:Department|Dept\.?|Agency|Commission|Authority|Bureau|Administration) (?:of|for) [A-Z][\w&' -]{2,50})/)
    // "CIO of Vermont Parks and Wildlife Department": the agency word at the end.
    ?? t.match(/\bof ((?:[A-Z][\w&']*|and|&)(?: (?:[A-Z][\w&']*|and|&))* (?:Department|Agency|Commission|Authority|Bureau))\b/);
  if (!m) return null;
  const claimed = m[1].toLowerCase();
  const own = distinctWords(orgName);
  if (!own.length) return null;
  return own.some((w) => claimed.includes(w)) ? null : m[1].trim();
}
