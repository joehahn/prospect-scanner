// Is this pasted profile the person on the card?
//
// Added 2026-10-29. The operator pastes straight from LinkedIn's people search
// without checking, and its first result is the wrong person 10-20% of the
// time, most often someone with the same name at another firm. A paste that
// ingests itself has nobody looking before it is written, so the page has to
// prove who it is: its header names the subject (the line above "· 2nd"), and
// the subject's own page names their employer.
//
// Shared by the paste box (which matches a page to a person) and `lead paste`
// (which refuses a page that is not that person's).

// Credentials and generational suffixes that trail a name.
const SUFFIX = /^(jr|sr|ii|iii|iv|phd|ph\.d|md|mba|cpa|pmp|cfa|cfp|esq)\.?$/;

// "Joe" is "Joseph", "Doug" is "Douglas", "Mike" is "Michael": the same first
// three letters, or one name the start of the other, or a listed pair.
const NICK = [['mike', 'michael'], ['bill', 'william'], ['bob', 'robert'], ['jim', 'james'],
  ['dick', 'richard'], ['peggy', 'margaret'], ['ted', 'edward'], ['jack', 'john'], ['liz', 'elizabeth'],
  ['beth', 'elizabeth'], ['tony', 'anthony'], ['chuck', 'charles'], ['joe', 'joseph'], ['ned', 'edward'],
  ['ned', 'edmond'], ['rudy', 'rudolph'], ['rudy', 'rodolphe'], ['sasha', 'alexander'], ['oleksandr', 'alexander'],
  // Pairs the three-letter rule misses (2026-11-27: a card's "Tom" refused his
  // own "Thomas" page).
  ['tom', 'thomas'], ['hank', 'henry'], ['harry', 'henry'], ['larry', 'lawrence'], ['jerry', 'gerald'],
  ['kate', 'catherine'], ['katie', 'catherine'], ['cathy', 'katherine'], ['becky', 'rebecca'],
  ['sally', 'sarah'], ['betsy', 'elizabeth'], ['molly', 'mary'], ['polly', 'mary'], ['bert', 'albert'],
  ['bert', 'robert'], ['gene', 'eugene'], ['jake', 'jacob'], ['dick', 'rick']];
const sameFirst = (a, b) => a === b || a.startsWith(b) || b.startsWith(a)
  || (a.length >= 3 && b.length >= 3 && a.slice(0, 3) === b.slice(0, 3))
  || NICK.some((n) => n.includes(a) && n.includes(b));

/**
 * A name as a page would print it: first name, surname, every word, and the
 * name they go by, or null. Hyphens split ("Ann-Contoso"); leading and
 * trailing initials drop ("J. Ann Contoso", "Ann Jo Contoso M.").
 */
export function nameKey(s) {
  const raw = String(s ?? '').split(',')[0];
  // "Robert (Rob) Roe" or 'Robert "Rob" Roe': the bracketed name is the one he goes by.
  const alias = (raw.match(/\(([^)]+)\)|["\u201c]([^"\u201d]+)["\u201d]/)?.slice(1).find(Boolean) ?? '')
    .toLowerCase().trim();
  let w = raw.replace(/\([^)]*\)|["\u201c][^"\u201d]*["\u201d]/g, ' ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z\s.']/g, ' ').split(/\s+/).map((x) => x.replace(/\.$/, ''))
    .filter((x) => /[a-z]/.test(x) && !/^(dr|mr|mrs|ms|prof)$/.test(x));
  while (w.length > 2 && SUFFIX.test(w[w.length - 1])) w.pop();
  while (w.length > 2 && w[0].length === 1) w.shift();
  // ONLY INITIALS AFTER THE FIRST NAME (2026-11-14): "Beth M S." outside the
  // network is Beth, a middle initial, and the surname's initial. Dropping the
  // trailing initial left "m" as her surname and refused her own page.
  if (w.length > 2 && w.slice(1).every((x) => x.length === 1)) w = [w[0], w[w.length - 1]];
  while (w.length > 2 && w[w.length - 1].length === 1) w.pop();
  return w.length < 2 ? null : { first: w[0], last: w[w.length - 1], words: w, alias };
}

/** At most one letter added, dropped or changed. */
function oneEditApart(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}

/** Does the name on the page (a key) belong to the name on file? */
export function sameName(head, name) {
  const k = nameKey(name);
  if (!head || !k) return false;
  // OUTSIDE YOUR NETWORK the surname is an initial: "Frantz F."
  // The first name may still be the long form of the one on file: "Michael V."
  // for a card that says Mike (2026-11-14).
  if (head.last.length === 1) {
    return k.last[0] === head.last && [k.first, k.alias].filter(Boolean).some((a) => sameFirst(a, head.first));
  }
  // A compound surname may print in full or in part ("Ann B. Contoso Fabrikam").
  // A SURNAME SPELLED A LETTER OFF, OR SPACED (2026-11-17): the book's "Luccheta"
  // for the page's "Lucchetta", "Al Kaabi" for "Alkaabi". Two pastes in a day
  // matched no one for this. Long surnames only; the firm on the page still has
  // to match before a paste is stored (notThisPerson).
  const joined = (x) => x.words.slice(1).join('');
  const surname = head.last === k.last || head.words.includes(k.last) || k.words.includes(head.last)
    || joined(head) === joined(k)
    || (head.last.length >= 6 && k.last.length >= 6 && oneEditApart(head.last, k.last));
  const first = [k.first, k.alias].filter(Boolean)
    .some((a) => [head.first, head.alias].filter(Boolean).some((b) => sameFirst(a, b)));
  return surname && first;
}

/** The subject's name: the line above their degree, skipping a pronoun line. */
export function headerName(text) {
  // Only the subject's own part: a page whose header has no degree line (it
  // happens) otherwise took the first name in "More profiles for you".
  const lines = ownPart(text).split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < Math.min(lines.length, 120); i++) {
    if (!/^·\s*(1st|2nd|3rd\+?)$/.test(lines[i])) continue;
    for (let j = i - 1; j >= 0; j--) {
      if (!lines[j] || /^\w+\s*\/\s*\w+$/.test(lines[j])) continue;
      // A headline is not a name: when the name line is missing, say nothing.
      const looksLikeName = !/\s(at|@)\s|[|@\d]/.test(lines[j]) && lines[j].split(/\s+/).length <= 6;
      return looksLikeName ? lines[j] : null;
    }
  }
  return null;
}

/**
 * The first name of a header whose surname is hidden, or null. A member may
 * show only a first name and dots ("Jane .."); the dots were read as a
 * one-letter surname and her own page matched no one (2026-11-22).
 */
export function hiddenSurnameFirst(head) {
  const m = String(head ?? '').trim().match(/^([\p{L}'’-]{2,})\s+[.·…]+$/u);
  return m ? m[1].normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase() : null;
}

/**
 * Whether a linkedin.com/in/ address could be this person's: its slug holds
 * the start of one of their names. A URL typed into the paste form is not
 * checked against the page, and one left over from the previous profile went
 * onto the next card (2026-11-22). Vanity slugs ("/in/tpf/") fail this about
 * 1 time in 120, so a miss drops the address, never the paste.
 */
export function slugFits(url, name) {
  const raw = String(url ?? '').toLowerCase().match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
  if (!raw) return true;
  let s; try { s = decodeURIComponent(raw); } catch { s = raw; }
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
  if (!s || /^acoaa/.test(s)) return true;   // LinkedIn's own member id, no name in it
  const k = nameKey(name);
  if (!k) return true;
  return [...k.words, k.alias].filter((w) => w && w.length >= 2)
    .some((w) => s.includes(w.replace(/[^a-z]/g, '').slice(0, 4)));
}

/** The page up to LinkedIn's suggestion rails, which are other people. */
export function ownPart(text) {
  const t = String(text);
  const rail = t.search(/^\s*(More profiles for you|People you may know|You might like|Get expert advice)/mi);
  return rail >= 0 ? t.slice(0, rail) : t;
}

// Words in a firm's name that say nothing about which firm it is.
const GENERIC = new Set(('the of and for at in on a an inc incorporated llc llp lp ltd co corp corporation company '
  + 'group holdings partners partner services service solutions international global national '
  + 'department dept office state county city board commissioners commission agency authority '
  + 'government division bureau district public '
  // EVERYDAY WORDS IN A FIRM'S NAME (2026-11-27): "new" in "New York Power
  // Authority" was found in a stranger's About ("a new position") and his page
  // was stored on that card. A word any sentence can carry identifies no firm.
  + 'new first united american general north south east west central one all best more').split(' '));

/** The words of a firm's name that identify it, folded. */
export function firmWords(orgName) {
  return String(orgName ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC.has(w));
}

/** Does the subject's own part of the page name the firm? Unknown firm names pass. */
export function firmOnPage(text, orgName) {
  const words = firmWords(orgName);
  if (!words.length) return true;
  const page = ownPart(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const has = (w) => new RegExp(`(^|[^a-z0-9])${w}($|[^a-z0-9])`).test(page);
  return words.some(has);
}

/**
 * How much of the firm's name the subject's own part of the page carries, 0 to
 * 1. FIRM WORDS ARE NOT EQUAL (2026-10-30): "Kevin P." outside the network fit
 * two Kevins, and one firm passed firmOnPage on "automotive" alone, from the
 * other's talk title. The firm the page names most fully is the subject's.
 */
export function firmShare(text, orgName) {
  const words = firmWords(orgName);
  if (!words.length) return 0;
  const page = ownPart(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return words.filter((w) => new RegExp(`(^|[^a-z0-9])${w}($|[^a-z0-9])`).test(page)).length / words.length;
}

/**
 * Why this page is not this person's, or null when it is. `name` and `orgName`
 * are what the card says.
 */
export function notThisPerson(text, name, orgName) {
  const head = headerName(text);
  const key = nameKey(head);
  if (key && !sameName(key, name)) {
    return `This is ${head}'s page, not ${name}'s: LinkedIn's search probably led to someone else.`;
  }
  if (!firmOnPage(text, orgName)) {
    return `This ${head ?? name} page never mentions ${orgName}, so it is probably a different ${name}. `
      + `If it really is them and they have moved on, record the move: npm run lead -- move --person <id> --to <org_id> --url <profile url>`;
  }
  return null;
}

/**
 * The page without LinkedIn's messaging overlay. A select-all copy carries the
 * operator's open conversations after the page footer (other people's private
 * messages, and his replies), and 19 stored pastes held one when this was
 * added on 2026-10-29. None of it is about the subject, so it is cut before
 * anything is stored or sent to a model. It always follows the footer, so the
 * cut loses nothing of the profile.
 */
export function withoutMessaging(text) {
  const t = String(text);
  const at = t.search(/^.*You are on the messaging overlay/m);
  if (at < 0) return t;
  // The footer's last lines ("Select language", then the operator's own name)
  // lead into it; stop at the footer's language picker when it is there.
  const head = t.slice(0, at);
  const lang = head.lastIndexOf('Select language');
  return (lang >= 0 && head.length - lang < 200 ? head.slice(0, lang) : head).replace(/\s+$/, '\n');
}
