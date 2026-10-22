// Is this person on this page at all?
//
// Added 2026-10-22. Web research returns facts with a URL each, and a URL is a
// claim like any other. An article by another CIO, on agentic AI governance,
// was filed as a portfolio operating partner's own words; the drafter led a
// note with it. Her name is nowhere on the page. A page that does not name the
// person is not evidence about them, whatever the model said it was.

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Credentials and suffixes that follow a surname in a name on file.
const SUFFIX = new Set(['phd', 'ph', 'd', 'md', 'mba', 'jr', 'sr', 'ii', 'iii', 'iv', 'cpa', 'pe', 'esq', 'cfa', 'cissp']);

/** The surname a page would print: the last word of the name that is not a credential. */
export function surnameOf(name) {
  const words = fold(name).replace(/\(.*?\)/g, ' ').split(/[^a-z'-]+/).filter(Boolean);
  while (words.length > 1 && SUFFIX.has(words[words.length - 1].replace(/[^a-z]/g, ''))) words.pop();
  return words[words.length - 1] ?? '';
}

/** True when the page names the person by surname; hyphenated surnames match either part's full form. */
export function nameOnPage(html, name) {
  const sur = surnameOf(name);
  if (sur.length < 2) return true;   // nothing checkable: do not drop on a guess
  const text = fold(html);
  const forms = [sur, sur.replace(/-/g, ' '), sur.replace(/-/g, '')];
  return forms.some((f) => new RegExp(`(^|[^a-z])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`).test(text));
}
