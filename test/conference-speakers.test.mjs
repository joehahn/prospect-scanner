// A speaker the agenda page does not name must never reach the book.
//
// `npm run conferences` reads agenda pages with a model instead of selectors,
// and a model can return a plausible name that is not on the page. This checks
// the guard that drops those, and that it tolerates the differences real pages
// have (case, accents, extra spacing, punctuation) without letting a near-miss
// through.
const R = decodeURIComponent(new URL('../', import.meta.url).pathname);
const { verifiedSpeakers, allowedCountries, inOperatorCountries } = await import(R + 'src/conferences.mjs');

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

// Where the event is, against the business's countries plus any a target adds.
const allowed = allowedCountries({ where: { countries: ['US'] }, targets: [{ where: { countries: ['Qatar'] } }] });
check(inOperatorCountries('United States', allowed) && inOperatorCountries('USA', allowed), 'the home country passes by name or abbreviation');
check(inOperatorCountries('Qatar', allowed), "a country one target adds passes");
check(!inOperatorCountries('Germany', allowed), 'a country no one works in is left out');
check(inOperatorCountries('', allowed) && inOperatorCountries('Online', allowed), 'unstated or online is let through');
check(inOperatorCountries('United States and United Kingdom', allowed), 'an event in several countries passes if one is ours');
check(!inOperatorCountries('Germany, Austria', allowed), 'an event only in others does not');

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log('\nall passed');
