// Does the pipeline work for a business that is not the author's?
//
// config/business.example.yml is a fictional cybersecurity consultancy, chosen
// because it shares nothing with the business this tool was built for. This
// loads it through the same loader every stage uses, renders what the judge
// would be shown, and checks two things: that it is complete, and that not one
// of the operator's own identifying terms turns up in it. A hardcoded offer,
// target or name anywhere between config and prompt would surface here.
import { readFileSync } from 'node:fs';
const R = decodeURIComponent(new URL('../', import.meta.url).pathname);
const { loadBusiness, readBusinessFile, describeForJudge } = await import(R + 'src/business.mjs');
const { forbiddenTerms } = await import(R + 'src/leaks.mjs');

const EXAMPLE = R + 'config/business.example.yml';
let fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); if (!ok) fail++; };

// 1. It is valid, by the same validator a real business.yml meets.
let doc = null;
try { doc = readBusinessFile(EXAMPLE); } catch (e) { console.log(e.message); }
check(doc, 'the example validates');

// 2. Loaded through the real loader, the shape is complete.
const b = loadBusiness({}, null, { path: EXAMPLE });
check(b._source === 'config/business.example.yml', 'loaded from the example file, not the old-config fallback');
check(b.offers.length >= 2 && b.offers.every((o) => o.name && o.price != null && o.for), 'every offer has a name, price and who it is for');
check(b.targets.length >= 2 && b.targets.every((t) => t.name && t.description), 'every target has a name and a description');
check(b.events.every((e) => e.name && e.description), 'every event has a name and a description');
check(b.targets.some((t) => t.size), 'a target can override the default size band');

// 3. What the judge would be shown is about THIS business.
const text = describeForJudge(b);
check(text.includes('SOC 2 Readiness') && text.includes('Regional healthcare providers'),
  "the judge's view names the example's own offers and targets");

// 4. And nothing of the operator's, anywhere in the example or in that view.
const { identity } = forbiddenTerms();
const raw = readFileSync(EXAMPLE, 'utf8');
const leaked = identity.filter((t) => raw.toLowerCase().includes(t.toLowerCase())
  || text.toLowerCase().includes(t.toLowerCase()));
check(!leaked.length, `no operator identity term in the example or the judge's view${leaked.length ? `: ${leaked.join(', ')}` : ''}`);

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
