// Is this name someone already on file? No model.
//
// A NAME SEEN IN A PROFILE'S SIDEBAR WAS FILED AS A NEW PERSON unless its slug
// matched one letter for letter, so a founder sat on file twice at one firm,
// once under his nickname, and a managing director was filed at the firm of
// the profile he was seen on while he was already on file at his real one
// (2026-10-19, both found by the operator on the board). A sweep then found 39
// such pairs, and one person had been written to twice, once on each record.
// A duplicate splits a record and hides a send; one at the wrong firm gets
// drafted to as someone he is not.
//
// Same surname and a first name that is the same, a nickname of it, or one
// starting the other. At the same firm that is enough. At another firm it also
// needs the titles to agree, because two John Smiths at two firms are usually
// two people, and the cost of a wrong match there is a lost lead.

const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'md', 'phd', 'cpa', 'mba', 'cfa', 'esq', 'pe', 'jd', 'dr', 'mr', 'ms', 'mrs']);

// Short forms that do not start with their full name. Prefixes (Ron/Ronald,
// Raj/Rajveer, Alex/Alexander) are caught without a list.
const NICK = [
  ['bob', 'robert'], ['bobby', 'robert'], ['bill', 'william'], ['billy', 'william'], ['dick', 'richard'],
  ['rick', 'richard'], ['ted', 'edward'], ['ned', 'edward'], ['jack', 'john'], ['jim', 'james'],
  ['jimmy', 'james'], ['peggy', 'margaret'], ['maggie', 'margaret'], ['meg', 'margaret'],
  ['chuck', 'charles'], ['hank', 'henry'], ['harry', 'henry'], ['larry', 'lawrence'],
  ['tony', 'anthony'], ['liz', 'elizabeth'], ['beth', 'elizabeth'], ['betty', 'elizabeth'],
  ['kathy', 'katherine'], ['katie', 'katherine'], ['sandy', 'sandra'], ['tina', 'christina'],
  ['becky', 'rebecca'], ['sue', 'susan'], ['nancy', 'ann'], ['polly', 'mary'], ['molly', 'mary'],
  ['jerry', 'gerald'], ['gene', 'eugene'], ['mandy', 'amanda'], ['cindy', 'cynthia'],
  ['debbie', 'deborah'], ['abby', 'abigail'], ['vicky', 'victoria'], ['wendy', 'gwendolyn'],
  ['olek', 'oleksandr'], ['sasha', 'alexander'], ['zach', 'zachary'],
  ['mike', 'michael'], ['mick', 'michael'], ['dave', 'david'], ['rudy', 'rodolphe'], ['rudy', 'rudolph'],
  ['josi', 'josephine'], ['jo', 'josephine'], ['angie', 'angela'], ['peg', 'margaret'], ['hal', 'harold'],
];
const nickOf = new Map();
for (const [a, b] of NICK) {
  if (!nickOf.has(a)) nickOf.set(a, new Set()); nickOf.get(a).add(b);
  if (!nickOf.has(b)) nickOf.set(b, new Set()); nickOf.get(b).add(a);
}

// A generation suffix tells a father from a son: Sam Lane Jr. and Sam
// Lane III are two people at one bank.
const GENERATION = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
// A seat word an agenda puts before a name: "Chief AB Lane".
const LEAD_TITLE = new Set(['chief', 'judge', 'senator', 'rep', 'representative', 'mayor', 'commissioner',
  'gen', 'general', 'adm', 'admiral']);
const ACCENTS = /[̀-ͯ]/g;

/**
 * {firsts, last} from a display name: "Rajveer (Raj) Kushwaha" -> firsts rajveer, raj.
 * Also, not enumerable so the shape stays {firsts, last}: `aliases` (the
 * parenthesised or quoted names), `middles` (middle initials) and `gen` (Jr.,
 * III), which tell two relatives apart (sameName).
 *
 * LEADING INITIALS (2026-11-20): "T.C Rao" is first name tc, and
 * "J. Mark Lane" goes by Mark. Both were read as having no first name, so
 * neither matched the record already on file and each was filed twice.
 */
export function nameParts(name) {
  const s = String(name ?? '');
  const aliases = [...s.matchAll(/\(([^)]+)\)|"([^"]+)"/g)]
    .map((m) => (m[1] ?? m[2]).trim().toLowerCase().normalize('NFD').replace(ACCENTS, '').split(/\s+/)[0])
    .filter((a) => a.length > 1);
  const [main, ...tail] = s.replace(/\([^)]*\)|"[^"]*"/g, ' ').split(',');
  const bare = (w) => w.replace(/[.'-]/g, '');
  let words = main.normalize('NFD').replace(ACCENTS, '').toLowerCase()
    .replace(/[^a-z\s.'-]/g, ' ').split(/\s+/).map((w) => w.replace(/^['-]+|['-]+$/g, '')).filter((w) => bare(w));
  const gen = [...words, ...tail.join(' ').toLowerCase().split(/[\s.]+/)].map(bare)
    .find((w) => GENERATION.has(w)) ?? null;
  // A credential is dropped anywhere but first place, where "J.D." is a name.
  words = words.filter((w, i) => !SUFFIX.has(bare(w)) || (i === 0 && !['dr', 'mr', 'ms', 'mrs'].includes(bare(w))));
  while (words.length > 2 && LEAD_TITLE.has(bare(words[0]))) words.shift();
  if (words.length < 2) return null;
  let rest = words.slice(0, -1);
  const initial = (w) => /^[a-z]\.?$/.test(w);
  const firsts = [];
  if (/^([a-z]\.)+[a-z]?\.?$/.test(rest[0]) && bare(rest[0]).length > 1) firsts.push(bare(rest[0]));   // T.C, J.D.
  else if (initial(rest[0]) && rest[1] && !initial(rest[1])) { firsts.push(bare(rest[1])); rest = rest.slice(1); } // J. Troy
  else if (initial(rest[0]) && rest[1]) { firsts.push(bare(rest[0]) + bare(rest[1])); rest = rest.slice(1); }     // T C
  else firsts.push(bare(rest[0]));
  const middles = rest.slice(1).filter(initial).map((w) => w[0]);
  const out = { firsts: [...new Set([...firsts, ...aliases])].filter((w) => w.length > 1), last: bare(words.at(-1)) };
  if (!out.firsts.length) return null;
  Object.defineProperties(out, { aliases: { value: aliases }, middles: { value: middles }, gen: { value: gen } });
  return out;
}

/**
 * Whether two parsed names are one person. Same surname and a first name
 * that is the same, a nickname of it, or one starting the other; and nothing
 * that says they are two relatives: different generation suffixes, different
 * middle initials (Paul G. and Paul C. Lane), or different
 * nicknames on one given name (James "Jim" and James "Will" Lane).
 */
export function sameName(me, them) {
  if (!me || !them || me.last !== them.last || !firstsMatch(me.firsts, them.firsts)) return false;
  if (me.gen && them.gen && me.gen !== them.gen) return false;
  if (me.middles?.length && them.middles?.length && me.middles[0] !== them.middles[0]) return false;
  if (me.aliases?.length && them.aliases?.length && !firstsMatch(me.aliases, them.aliases)) return false;
  return true;
}

/**
 * Whether a page names this person: the surname anywhere, or a first name and
 * the surname's initial ("Omar H."), which is how LinkedIn shows someone
 * outside your network. A state CDO's own profile was refused as someone
 * else's because the page never spelled out the surname.
 */
export function pageNames(text, name) {
  const parts = nameParts(name);
  if (!parts) return true;
  const t = String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (t.includes(parts.last)) return true;
  // A surname spelled with a space, hyphen or apostrophe on one side and run
  // together on the other is one name: "Al Mazrouei" is the page of a card
  // that says "Almazrouei" (2026-11-18).
  const squash = (s) => s.replace(/[\s'’-]+/g, '');
  if (squash(t).includes(squash(parts.last))) return true;
  // A preferred or native name in parentheses can sit between first name and
  // initial: "Richard (Tzuulin) Y." is the page of Richard Y.
  const bare = t.replace(/\([^)]*\)/g, ' ').replace(/[ \t]+/g, ' ');
  return parts.firsts.some((f) => new RegExp(`\\b${f}\\s+${parts.last[0]}\\.`).test(bare));
}

const firstsMatch = (a, b) => a.some((x) => b.some((y) => x === y
  || (Math.min(x.length, y.length) >= 3 && (x.startsWith(y) || y.startsWith(x)))
  || nickOf.get(x)?.has(y)));

// Seat words every title shares, which say nothing about which seat it is.
const TITLE_STOP = new Set(['and', 'of', 'the', 'at', 'for', 'to', 'in', 'chief', 'officer', 'head', 'senior',
  'vice', 'president', 'director', 'managing', 'executive', 'global', 'lead', 'group']);
const titleWords = (t) => new Set(String(t ?? '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
  .filter((w) => w.length > 2 && !TITLE_STOP.has(w)));

/** Whether two titles describe the same seat: their distinctive words mostly shared, two where both have two. */
export function titlesAgree(a, b) {
  const x = titleWords(a), y = titleWords(b);
  const small = Math.min(x.size, y.size);
  const shared = [...x].filter((w) => y.has(w)).length;
  return small > 0 && shared >= Math.min(2, small) && shared >= small / 2;
}

/**
 * The person on file this name most likely is, or null. `orgId` is the firm
 * the name was seen at; a match there needs only the name, a match at any
 * other firm also needs the titles to agree.
 */
export function samePersonOnFile(db, { name, title = null, orgId }) {
  const me = nameParts(name);
  if (!me) return null;
  const rows = db.prepare(`SELECT id, name, title, org_id FROM people
    WHERE lower(name) LIKE ?`).all(`%${me.last}%`);
  let other = null;
  for (const r of rows) {
    if (!sameName(me, nameParts(r.name))) continue;
    if (r.org_id === orgId) return { ...r, sameOrg: true };
    if (!other && title && titlesAgree(title, r.title)) other = { ...r, sameOrg: false };
  }
  return other;
}

/**
 * The id to file a name under at this firm: the person already on file there
 * under another spelling, or `fresh` (the new slug) when there is none.
 *
 * EVERY INTAKE ASKS (2026-11-20). Only two of seven places that file people
 * asked samePersonOnFile; the others matched slugs letter for letter, so an
 * agenda's "Timothy James TJ" sat beside a pasted "TJ" and his pastes went to
 * one card while the other kept asking for one. 31 such pairs were merged.
 * Only a match AT THIS FIRM is reused: a name at another firm is left to `lead
 * move`, which takes a source.
 */
export function personIdAt(db, orgId, name, fresh) {
  const known = samePersonOnFile(db, { name, orgId });
  return known?.sameOrg ? known.id : fresh;
}
