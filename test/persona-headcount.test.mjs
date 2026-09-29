// Does buyer_below_headcount promote only when it should?
//
// The rule has three parts and the third is the one that matters: a persona
// carrying `buyer_below_headcount: N` reads as `buyer` at a KNOWN headcount at
// or below N, keeps its declared tier at or above N, and — the discipline —
// promotes NOBODY when the headcount is unknown. A firm nobody has sized is
// unsized, not small.
const R = decodeURIComponent(new URL('../src/', import.meta.url).pathname);
const { matchPersona } = await import(R+'targeting.mjs');

const V = { id: 'test_thesis', personas: [
  { title_patterns: ['Owner', 'President'], authority: 'buyer' },
  { title_patterns: ['VP Supply Chain', 'VP Manufacturing', 'Head of Manufacturing'],
    authority: 'router', buyer_below_headcount: 1000 },
  { title_patterns: ['CIO', 'Chief Information Officer'], authority: 'router' },
]};

// [title, headcount, expected authority, why]
const CASES = [
  // --- the split itself
  ['VP Supply Chain',           300,  'buyer',  'a snack maker at 300 — the case this was built for'],
  ['VP Supply Chain',           999,  'buyer',  'just under the line'],
  ['VP Supply Chain',          1000,  'buyer',  'AT the line is below it, per "at or below"'],
  ['VP Supply Chain',          1001,  'router', 'just over the line keeps the declared tier'],
  ['VP Supply Chain',          9000,  'router', 'a chipmaker — the enterprise reading is unchanged'],
  // --- THE DISCIPLINE. An unknown size is not a small size.
  ['VP Supply Chain',          null,  'router', 'unsized is not small'],
  ['VP Supply Chain',     undefined,  'router', 'undefined is not small either'],
  ['VP Supply Chain',           0,    'router', 'zero is a bad number, not a tiny firm'],
  ['VP Supply Chain',          -5,    'router', 'negative is a bad number too'],
  ['VP Supply Chain',       'lots',   'router', 'a non-number never promotes'],
  // --- the interpolated title still reaches the persona, and still splits
  ['VP, Integrated Supply Chain', 300, 'buyer', 'modifier-aware match carries the promotion'],
  ['SVP Global Manufacturing', 5000,  'router', 'and carries the non-promotion'],
  // --- personas WITHOUT the qualifier are untouched at every size
  ['Chief Information Officer',  50,  'router', 'no qualifier, no promotion, however small'],
  ['Chief Information Officer',9000,  'router', 'no qualifier, unchanged'],
  // --- a persona already `buyer` is unaffected
  ['President',                9000,  'buyer',  'buyer stays buyer above the line'],
  ['President',                  50,  'buyer',  'and below it'],
];

let pass=0, fail=0;
for (const [title, hc, want, why] of CASES) {
  const got = matchPersona(V, title, hc)?.authority ?? '(no match)';
  const ok = got === want;
  ok ? pass++ : fail++;
  if (!ok) console.log(`  FAIL  want ${want.padEnd(7)} got ${String(got).padEnd(9)} `
    + `"${title}" @ ${String(hc)}  — ${why}`);
}

// The promotion must be visible in the result, not silent: `vet`-style
// auditability. Knowing WHICH people were promoted is what keeps this honest.
const promoted = matchPersona(V, 'VP Supply Chain', 300);
if (promoted?.promoted_below_headcount !== 1000) {
  fail++; console.log('  FAIL  a promoted persona does not record promoted_below_headcount');
} else pass++;
const notPromoted = matchPersona(V, 'VP Supply Chain', 5000);
if (notPromoted?.promoted_below_headcount !== undefined) {
  fail++; console.log('  FAIL  an unpromoted persona claims promoted_below_headcount');
} else pass++;

console.log(`\n  ${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
