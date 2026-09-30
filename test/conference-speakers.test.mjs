// A speaker the agenda page does not name must never reach the book.
//
// `npm run conferences` reads agenda pages with a model instead of selectors,
// and a model can return a plausible name that is not on the page. This checks
// the guard that drops those, and that it tolerates the differences real pages
// have (case, accents, extra spacing, punctuation) without letting a near-miss
// through.
const R = decodeURIComponent(new URL('../', import.meta.url).pathname);
const { verifiedSpeakers } = await import(R + 'src/conferences.mjs');

let fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); if (!ok) fail++; };

const page = `Speakers  JANE  DOE  VP Operations, Acme Freight
  Session: What our AI pilot taught us.  José Álvarez-Ruiz, Director of Data, Norte Logistics`;
const s = (name, firm = 'Acme Freight', title = 'VP Operations') => ({ name, firm, title, session: '' });

check(verifiedSpeakers([s('Jane Doe')], page).length === 1, 'a name on the page is kept, whatever the case and spacing');
check(verifiedSpeakers([s('Jose Alvarez-Ruiz', 'Norte Logistics', 'Director of Data')], page).length === 1,
  'accents and punctuation do not matter');
check(verifiedSpeakers([s('John Smith')], page).length === 0, 'a name not on the page is dropped');
check(verifiedSpeakers([s('Jane Doe', '')], page).length === 0, 'a speaker without a firm is dropped');
check(verifiedSpeakers([s('Jane Doe', 'Acme Freight', '')], page).length === 0, 'a speaker without a title is dropped');
check(verifiedSpeakers([s('Jane Do')], 'Speakers: Jane Doerr, VP').length === 0,
  'a name that is only the start of another name is dropped');

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log('\nall passed');
