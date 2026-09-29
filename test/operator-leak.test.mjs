// Is anything about the operator, or a prospect, in code or prompts that would
// be published? See src/leaks.mjs for how the terms are found (from config,
// never listed here) and CLAUDE.md for the rule.
//
// Identity, prices and prospect names were cleared to zero on 2026-09-25; firm
// names, addresses at firms in the book and hardcoded thesis and trigger ids on
// 2026-09-29. All must stay at zero. An id the code needs belongs in a public
// *.example.yml template; one business's choice belongs in config.
const R = decodeURIComponent(new URL('../src/', import.meta.url).pathname);
const { findLeaks } = await import(R + 'leaks.mjs');

const hits = findLeaks();
const count = (k) => hits.filter((h) => h.kind === k).length;

let fail = 0;
for (const k of ['identity', 'price', 'prospect', 'firm', 'address', 'id']) {
  const n = count(k);
  if (n) {
    fail++;
    console.log(`FAIL  ${k}: ${n} (must be 0)`);
    for (const h of hits.filter((x) => x.kind === k)) console.log(`        ${h.file}:${h.line}  ${h.term}`);
  } else console.log(`ok    ${k}: 0`);
}
if (fail) process.exit(1);
