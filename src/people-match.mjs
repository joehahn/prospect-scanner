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
];
const nickOf = new Map();
for (const [a, b] of NICK) {
  if (!nickOf.has(a)) nickOf.set(a, new Set()); nickOf.get(a).add(b);
  if (!nickOf.has(b)) nickOf.set(b, new Set()); nickOf.get(b).add(a);
}

/** {firsts: [...], last} from a display name: "Rajveer (Raj) Kushwaha" -> firsts rajveer, raj. */
export function nameParts(name) {
  let s = String(name ?? '');
  const aliases = [...s.matchAll(/\(([^)]+)\)|"([^"]+)"/g)].map((m) => (m[1] ?? m[2]).trim().toLowerCase());
  s = s.replace(/\([^)]*\)|"[^"]*"/g, ' ').split(',')[0];
  const words = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ').split(/\s+/).map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w && !SUFFIX.has(w.replace(/[.'-]/g, '')));
  if (words.length < 2) return null;
  const firsts = [words[0], ...aliases.flatMap((a) => a.split(/\s+/).slice(0, 1))].filter((w) => w.length > 1);
  return { firsts: [...new Set(firsts)], last: words.at(-1) };
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
    const them = nameParts(r.name);
    if (!them || them.last !== me.last || !firstsMatch(me.firsts, them.firsts)) continue;
    if (r.org_id === orgId) return { ...r, sameOrg: true };
    if (!other && title && titlesAgree(title, r.title)) other = { ...r, sameOrg: false };
  }
  return other;
}
