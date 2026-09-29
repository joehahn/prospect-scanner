// The same seat with the rank word on the other side.
//
// Persona lists are written with ONE rank per seat noun -- "Continuous
// Improvement Manager" -- and real conference agendas print every rank there is
// -- "Director of Continuous Improvement". Same job, and before this rule, no
// match. 48 of 93 conference speakers matched no persona and a run of them were
// exactly this.
//
// The looseness is deliberate: a Director and a Manager of the same function are
// the same persona, because authority comes from the persona, not from which
// rank word the config author happened to type. That is precisely why the guards
// below matter, and every `false` case here is a match that would otherwise
// happen.
const R = decodeURIComponent(new URL('../src/', import.meta.url).pathname);
const { seatMatchesWithRankFirst } = await import(R+'targeting.mjs');
const { titleFitsBuyer } = await import(R+'config.mjs');

const n = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
const m = (title, pattern) => seatMatchesWithRankFirst(n(title), n(pattern));

const CASES = [
  // --- THE REAL UNMATCHED TITLES THIS WAS BUILT FOR
  [true,  'Director of Continuous Improvement',      'Continuous Improvement Manager'],
  [true,  'Head of Continuous Improvement',          'Continuous Improvement Manager'],
  [true,  'Manager of Operational Excellence',       'Operational Excellence Manager'],
  [true,  'Director, Operational Excellence',        'Operational Excellence Manager'],
  [true,  'VP of Continuous Improvement',            'Continuous Improvement Manager'],

  // --- GUARD 1: the seat must be two words or more.
  // "Plant Manager" reduces to the seat "plant", which would swallow anything
  // with a plant in it.
  [false, 'Director of Plant Operations',            'Plant Manager'],
  [false, 'VP of Plant Engineering',                 'Plant Manager'],
  [false, 'Head of Supply',                          'Supply Manager'],

  // --- GUARD 2: a subordinate of a seat is not that seat
  [false, 'Deputy Director of Continuous Improvement','Continuous Improvement Manager'],
  [false, 'Assistant Head of Operational Excellence', 'Operational Excellence Manager'],
  [false, 'Interim Director of Continuous Improvement','Continuous Improvement Manager'],

  // --- the pattern must END in a rank noun, or this rule is not about it
  [false, 'Manager of Quality',                      'Director of Quality'],
  [false, 'Head of Business Analytics',              'Business Analytics'],

  // --- the seat words must all be there, in order
  [false, 'Director of Continuous Delivery',         'Continuous Improvement Manager'],
  [false, 'Director of Improvement',                 'Continuous Improvement Manager'],
  [false, 'Head of Chain Supply',                    'Supply Chain Manager'],

  // --- must not reach across an unrelated seat
  [false, 'Director of Human Resources',             'Continuous Improvement Manager'],
  [false, 'Chief Executive Officer',                 'Chief Information Officer'],
];

let pass=0, fail=0;
for (const [want, title, pattern] of CASES) {
  let got; try { got = m(title, pattern); } catch (e) { got = `THREW ${e.message}`; }
  const ok = got === want;
  ok ? pass++ : fail++;
  if (!ok) console.log(`  FAIL  want ${String(want).padEnd(5)} got ${String(got).padEnd(5)} "${title}" vs "${pattern}"`);
}

// THE REGRESSIONS THE OTHER SUITE RECORDS MUST SURVIVE THE NEW RULE, and this
// checks them through titleFitsBuyer, which now calls it.
const MUST_STAY_FALSE = [
  ['Executive Vice President',          ['President']],
  ['Deputy Chief Information Officer',  ['Chief Information Officer']],
  ['Vice President, Human Resources',   ['President']],
  ['Associate Vice Chancellor',         ['Chancellor']],
  ['Chief Financial Officer',           ['Chief Supply Chain Officer']],
];
for (const [title, pats] of MUST_STAY_FALSE) {
  const got = Boolean(titleFitsBuyer(title, pats));
  if (got) { fail++; console.log(`  FAIL  regression: "${title}" now matches ${JSON.stringify(pats)}`); }
  else pass++;
}
// And the CFO gap, end to end.
for (const t of ['CFO','Chief Financial Officer','Chief Accounting Officer','CAO']) {
  const got = Boolean(titleFitsBuyer(t, ['Chief Financial Officer','CFO','Chief Accounting Officer','CAO']));
  if (!got) { fail++; console.log(`  FAIL  "${t}" does not match the finance persona`); }
  else pass++;
}

console.log(`\n  ${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
