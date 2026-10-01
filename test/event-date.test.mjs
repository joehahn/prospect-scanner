// Does the stage know when the talk is?
//
// It did not, and a draft went out in the past tense about a panel seven weeks
// in the future. The speaker record said "the session is the dated reason to
// write" while carrying only the date the agenda was fetched, so the angle
// writer guessed the tense and guessed it differently each time.
const R = decodeURIComponent(new URL('../src/', import.meta.url).pathname);
const { eventDateFrom, tenseFor, dateForAgenda, markAgendaDays } = await import(R+'events.mjs');

const CASES = [
  // --- THE REAL ONE. Biomanufacturing World Summit, from its own landing page.
  ['<div class="hero">November 9-11, 2026</div><p>San Diego Bayfront</p>', '2026-11-09', 'November 9-11, 2026'],
  // --- the dash variants publishers actually use
  ['<h2>March 9 – 11, 2026</h2>', '2026-03-09', null],
  ['<h2>March 9 — 11, 2026</h2>', '2026-03-09', null],
  ['<span>October 5-7, 2027</span>',   '2027-10-05', null],
  // --- a single day, and no comma
  ['<p>Join us June 3, 2026 in Chicago</p>', '2026-06-03', null],
  ['<p>Join us June 3 2026 in Chicago</p>',  '2026-06-03', null],
  // --- tags and entities must not break the read
  ['<b>November</b>&nbsp;<b>9-11</b>, <i>2026</i>', null, null],   // split across tags: not found, and that is honest
  // --- nothing to find
  ['<p>Register now for the summit</p>', null, null],
  ['', null, null],
  [null, null, null],
  [undefined, null, null],
];

let pass=0, fail=0;
for (const [html, wantIso, wantText] of CASES) {
  let got; try { got = eventDateFrom(html); } catch (e) { got = `THREW ${e.message}`; }
  const iso = got && got.starts_on ? got.starts_on : null;
  let ok = iso === wantIso;
  if (ok && wantText) ok = got.text === wantText;
  ok ? pass++ : fail++;
  if (!ok) console.log(`  FAIL  want ${wantIso} got ${JSON.stringify(got)} — ${String(html).slice(0,44)}`);
}

// A RANGE MUST NOT BE READ AS A SINGLE DAY. Taking the single-day pattern first
// would match "November 9" inside "November 9-11" and silently drop the end,
// which reads as a one-day event that is really three.
const r = eventDateFrom('<p>November 9-11, 2026</p>');
if (r?.text !== 'November 9-11, 2026') { fail++; console.log(`  FAIL  range collapsed to ${JSON.stringify(r)}`); }
else pass++;

// --- tense, which is the whole point
const T = [
  ['2026-11-09', '2026-09-23', 'upcoming', 'seven weeks out — the case that caused this', 2026],
  ['2026-09-23', '2026-09-23', 'past',     'today is not still to come', 2026],
  ['2026-03-09', '2026-09-23', 'past',     'six months ago', 2026],
  [null,         '2026-09-23', null,       'no date means no claim about tense', 2026],
  // THE TRAP: the landing page advertises the NEXT edition. A 2027 date beside a
  // 2026 agenda means the talk in hand already happened — not that it is coming.
  ['2027-03-08', '2026-09-23', 'past',     'page rolled to 2027, agenda is 2026', 2026],
  ['2027-05-17', '2026-09-23', 'past',     'same, eight months further out', 2026],
  ['2027-03-08', '2026-09-23', 'upcoming', 'no agenda year given: fall back to the plain read', null],
];
for (const [starts, today, want, why, yr] of T) {
  const got = tenseFor(starts, today, yr);
  if (got !== want) { fail++; console.log(`  FAIL  tense want ${want} got ${got} — ${why}`); }
  else pass++;
}

// And the date itself is dropped rather than misattached.
for (const [when, yr, wantNull, why] of [
  [{text:'March 8-10, 2027', starts_on:'2027-03-08'}, 2026, true,  'next edition: print no date at all'],
  [{text:'November 9-11, 2026', starts_on:'2026-11-09'}, 2026, false, 'same year: keep it'],
  [null, 2026, true, 'nothing in, nothing out'],
]) {
  const got = dateForAgenda(when, yr);
  const isNull = got === null;
  if (isNull !== wantNull) { fail++; console.log(`  FAIL  dateForAgenda — ${why}`); }
  else pass++;
}

// A RANGE ACROSS A MONTH. A three-day insurance event ran September 29 to
// October 1; read as its last day, every session became "today" on the 1st.
for (const [text, start, end] of [
  ['September 29–October 1, 2026', '2026-09-29', '2026-10-01'],
  ['<b>March 30 - April 2, 2027</b>', '2027-03-30', '2027-04-02'],
  ['November 9-11, 2026', '2026-11-09', '2026-11-11'],
]) {
  const got = eventDateFrom(text);
  if (got?.starts_on !== start || got?.ends_on !== end) {
    fail++; console.log(`  FAIL  ${text} -> ${got?.starts_on}..${got?.ends_on}, want ${start}..${end}`);
  } else pass++;
}

// A TABBED AGENDA: day labels sit together at the top, each day's sessions in a
// block tied to its label only by a date-shaped id. Each block must say its day.
{
  const html = '<ul><li>Tuesday 29</li><li>Wednesday 30</li></ul>'
    + '<div class="wrap" id="29-sep-2026"><p>Session A</p></div>'
    + '<div class="wrap" id="30-sep-2026"><p>Session B</p></div><div id="main"><p>x</p></div>';
  const out = markAgendaDays(html);
  const a = out.indexOf('Session A'); const b = out.indexOf('Session B');
  const dayA = out.lastIndexOf('[DAY 2026-09-29]', a); const dayB = out.lastIndexOf('[DAY 2026-09-30]', b);
  if (dayA < 0 || dayB < 0 || dayB < a || /\[DAY [^\]]*\]\s*<p>x/.test(out)) {
    fail++; console.log('  FAIL  markAgendaDays did not label each day block, or labelled a non-date id');
  } else pass++;
}

console.log(`\n  ${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
