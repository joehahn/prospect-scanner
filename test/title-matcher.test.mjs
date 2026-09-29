const R = decodeURIComponent(new URL('../src/', import.meta.url).pathname);
const { titleFitsBuyer } = await import(R+'config.mjs');
// [title, patterns, expected]
const CASES = [
  // --- the interpolated titles this is meant to fix
  ['Executive Vice President, Global Technical Operations', ['VP Technical Operations'], true],
  ['VP, Integrated Supply Chain',            ['VP Supply Chain'],            true],
  ['SVP Global Manufacturing',               ['VP Manufacturing'],           true],
  ['Senior Vice President, Manufacturing Operations', ['VP Manufacturing'],  true],
  ['Vice President of Engineering',          ['VP Engineering'],             true],
  ['Director, Global Supply Chain Operations',['Director of Supply Chain'],  true],
  // --- already working, must stay working
  ['Senior Vice President, Quality',         ['VP Quality'],                 true],
  ['Chief Supply Chain Officer',             ['Chief Supply Chain Officer'], true],
  ['Continuous Improvement Manager',         ['Continuous Improvement Manager'], true],
  ['Director of Logistics',                  ['Director of Logistics'],      true],
  ['Chief Data Officer',                     ['Chief Data Officer'],         true],
  ['Director of Artificial Intelligence',    ['Director of AI'],             true],
  // --- THE REGRESSIONS THIS FILE RECORDS. All must stay false.
  ['Executive Vice President',               ['President'],                  false],
  ['Associate Vice Chancellor',              ['Chancellor'],                 false],
  ['Deputy Chief Information Officer',       ['Chief Information Officer'],  false],
  ['Vice President, Human Resources',        ['President'],                  false],
  // --- must not match across unrelated seats
  ['Chief Financial Officer',                ['Chief Supply Chain Officer'], false],
  ['VP of Engineering, Finance Systems',     ['VP Finance'],                 false],
  ['Director of Finance',                    ['Director of Supply Chain'],   false],
  ['General Counsel',                        ['General Manager'],            false],
  ['Head of Investor Relations',             ['Head of IT'],                 false],
];
let pass=0,fail=0;
for (const [title,pats,want] of CASES){
  const got = Boolean(titleFitsBuyer(title,pats));
  const ok = got===want;
  ok?pass++:fail++;
  if(!ok) console.log(`  FAIL  want ${String(want).padEnd(5)} got ${String(got).padEnd(5)} "${title}"  vs  ${JSON.stringify(pats)}`);
}
console.log(`\n  ${pass} pass, ${fail} fail`);
