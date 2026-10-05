// Is this organisation a public body? From its name, for the places that file an
// organisation without reading its site: conference speakers, and the backfill.
//
// WHY THIS EXISTS. Cities, counties, state agencies and police departments were
// filed as `end_client`, the same kind as a company, so the pitch selector had
// no way to treat them differently -- and they are bought differently. Added
// 2026-10-02 with the `public_body` kind.
//
// A NAME IS A STRONG HINT, NOT A PROOF. "County" also names county-level
// companies ("<Name> County Container Group"), so a corporate suffix vetoes
// the match; and a public university or hospital district reads as public while
// a private one with a similar name does not. Where the vet reads the body's
// own site, its classification (prompts/enrich-firm.md) wins over this.

const STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware',
  'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine',
  'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
  'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma',
  'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont',
  'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming', 'District of Columbia'].join('|');

const PUBLIC = [
  /^(city|town|village|borough|township|county|state|commonwealth|port|parish) of\b/i,
  /\b(county|city|municipality)\b(?!\s+(container|bank|title|electric|line))/i,
  /\bdepartment of\b/i, /\boffice of (the )?(governor|technology|information|innovation|budget|management)/i,
  /\b(state|highway|metropolitan|municipal) (police|patrol)\b/i, /\bpolice department\b/i, /\bsheriff'?s?\b/i,
  /\bpublic safety\b/i, /\bfire (department|rescue)\b/i,
  /\b(independent )?school district\b/i, /\bisd\b/i, /\bcommunity college district\b/i,
  /\b(transit|transportation|housing|water|port|airport|river|toll(way)?|utility) (authority|district)\b/i,
  /\bappraisal district\b/i, /\bhospital district\b/i, /\bcouncil of governments\b/i,
  /\bcomptroller\b/i, /\b(state|county|city) (board|commission|agency)\b/i, /\bboard of (pharmacy|education|elections|equalization)\b/i,
  /\bdigital service\b/i, /\b(data center|information resources)\b.*\b(county|state)\b|\b(county|state)\b.*\b(data center|information resources)\b/i,
  /\bgovernor'?s office\b/i, /\bexecutive office of\b/i, /\bstate of [a-z]+\b/i,
  // A state agency named for its state: "<State> Workforce Commission".
  new RegExp(`\\b(${STATES})\\b.*\\b(commission|board|agency|authority|court|department|division|bureau|office)\\b`, 'i'),
  /\battorney general\b/i, /\bemergency management\b/i, /\binternational airport\b/i,
  /\btrial court\b|\bjudicial (council|information|branch)\b/i, /\boffice of the chief (technology|information|data) officer\b/i,
];
const CORPORATE = /\b(inc|llc|ltd|plc|corp|corporation|company|co|group|holdings|partners|bank|credit union|fcu|insurance|mutual)\.?$/i;

export function looksPublic(name) {
  const n = String(name ?? '').trim();
  if (!n || CORPORATE.test(n)) return false;
  return PUBLIC.some((re) => re.test(n));
}
