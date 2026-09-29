// Can a proposed signal quote itself?
//
// `glean` lets text the operator pasted fire a trigger, and the thing standing
// between that and a fabricated dossier line is this check: the quote the model
// returns must appear VERBATIM in the evidence body, or the signal is refused.
// The prompt says so too, but a prompt is guidance and this is a control.
//
// The rule the cases below pin down: only line wrapping is forgiven. Case,
// accents, punctuation and wording all have to match, because those are exactly
// how a claim gets quietly distorted on its way into a dossier.
const R = decodeURIComponent(new URL('../src/', import.meta.url).pathname);
const { quoteIsInBody } = await import(R+'glean.mjs');

// A real body, hard wrapped the way `lead -- paste` stores one.
const BODY = `Dana Whitfield · 3rd degree
Vice President, Supply Chain at MERIDIAN.

Eight months ago, in their own words:
    "I am excited to announce that we are adding to our Supply Chain group
    within the Operations team here at Meridian with a NEWLY CREATED MANAGER OF
    PLANNING OPTIMIZATION role. We're looking for a candidate that has a strong
    supply chain foundation WHO HAS ALSO BEEN A HANDS-ON DRIVER OF TECHNOLOGY
    AND SYSTEMS IMPLEMENTATION."
The firm is doubling production by 2026 across two new plants.`;

const CASES = [
  // --- what must pass
  [true,  'a span copied exactly, on one line',
   'We\'re looking for a candidate that has a strong supply chain foundation'],
  [true,  'a span copied across the stored line wrapping',
   'we are adding to our Supply Chain group within the Operations team here at Meridian'],
  [true,  'a span whose internal whitespace was re-flowed',
   'NEWLY   CREATED   MANAGER   OF   PLANNING   OPTIMIZATION role'],
  [true,  'leading and trailing whitespace is trimmed',
   '   The firm is doubling production by 2026 across two new plants.   '],

  // --- WHAT MUST FAIL. Each one is a way a claim gets distorted.
  [false, 'a paraphrase, however faithful',
   'Meridian is adding a newly created role for planning optimization to its supply chain group'],
  [false, 'a tidied quote — punctuation changed',
   'We are looking for a candidate that has a strong supply chain foundation'],
  [false, 'case changed',
   'newly created manager of planning optimization role'],
  [false, 'a word inserted that is not there',
   'we are urgently adding to our Supply Chain group within the Operations team'],
  [false, 'a number changed',
   'The firm is doubling production by 2027 across two new plants.'],
  [false, 'text from nowhere',
   'We have budget approved for an external forecasting partner this quarter.'],
  [false, 'a quote too short to prove anything',
   'Supply Chain'],
  [false, 'a single common word, which would match almost any body',
   'the'],
  [false, 'empty',  ''],
  [false, 'whitespace only', '     '],

  // --- degenerate inputs must not throw and must not pass
  [false, 'null quote',      null],
  [false, 'undefined quote', undefined],
];

let pass=0, fail=0;
for (const [want, why, quote] of CASES) {
  let got;
  try { got = quoteIsInBody(quote, BODY); }
  catch (e) { got = `THREW ${e.message}`; }
  const ok = got === want;
  ok ? pass++ : fail++;
  if (!ok) console.log(`  FAIL  want ${String(want).padEnd(5)} got ${String(got).padEnd(5)} — ${why}`);
}

// A body that is missing or empty can never corroborate anything.
for (const [body, why] of [[null,'null body'],['','empty body'],[undefined,'undefined body']]) {
  let got; try { got = quoteIsInBody('a quote long enough to clear the floor', body); }
  catch (e) { got = `THREW ${e.message}`; }
  if (got !== false) { fail++; console.log(`  FAIL  ${why} should never corroborate, got ${got}`); }
  else pass++;
}

console.log(`\n  ${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
