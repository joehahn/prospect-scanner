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
  ['ned', 'edmond'], ['rudy', 'rudolph'], ['rudy', 'rodolphe'], ['sasha', 'alexander'], ['oleksandr', 'alexander']];
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
    .filter((x) => x && !/^(dr|mr|mrs|ms|prof)$/.test(x));
  while (w.length > 2 && SUFFIX.test(w[w.length - 1])) w.pop();
  while (w.length > 2 && w[0].length === 1) w.shift();
  while (w.length > 2 && w[w.length - 1].length === 1) w.pop();
  return w.length < 2 ? null : { first: w[0], last: w[w.length - 1], words: w, alias };
}

/** Does the name on the page (a key) belong to the name on file? */
export function sameName(head, name) {
  const k = nameKey(name);
  if (!head || !k) return false;
  // OUTSIDE YOUR NETWORK the surname is an initial: "Frantz F."
  if (head.last.length === 1) return k.first === head.first && k.last[0] === head.last;
  // A compound surname may print in full or in part ("Ann B. Contoso Fabrikam").
  const surname = head.last === k.last || head.words.includes(k.last) || k.words.includes(head.last);
  const first = [k.first, k.alias].filter(Boolean)
    .some((a) => [head.first, head.alias].filter(Boolean).some((b) => sameFirst(a, b)));
  return surname && first;
}

/** The subject's name: the line above their degree, skipping a pronoun line. */
export function headerName(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());
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
  + 'government division bureau district public').split(' '));

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
