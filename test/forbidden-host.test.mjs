// Does the LinkedIn guard still refuse everything except the one link it allows?
//
// On 2026-09-25 the operator granted one exception: a dashboard card may carry
// an href to LinkedIn's people search, which he clicks himself. The guard in
// config.mjs matches that line exactly. These cases plant each near-miss in a
// scratch source tree and check that the guard still fails the run on it.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const R = decodeURIComponent(new URL('../src/', import.meta.url).pathname);
const { assertForbiddenHostsUnused } = await import(R+'config.mjs');

const cfg = { forbidden_hosts: [{ host: 'linkedin.com' }] };
const LINK = '  const href = `https://www.linkedin.com/search/results/people/?keywords=${q}`;';

const CASES = [
  // [label, file, line, should the guard refuse it?]
  ['the allowed link, in dash.mjs',           'dash.mjs', LINK, false],
  ['the same link in any other module',       'news.mjs', LINK, true],
  ['fetching the search URL, even in dash',   'dash.mjs', '  await fetch(`https://www.linkedin.com/search/results/people/?keywords=${q}`);', true],
  ['the allowed line with a call bolted on',  'dash.mjs', LINK.replace(';', '; fetch(href);'), true],
  ['a profile URL, not a search',             'dash.mjs', '  const href = `https://www.linkedin.com/in/${slug}`;', true],
  ['a different variable name',               'dash.mjs', LINK.replace('${q}', '${q}&origin=x'), true],
  ['goto via a browser',                      'dash.mjs', "  await page.goto('https://www.linkedin.com/feed/');", true],
];

let fail = 0;
for (const [label, file, line, refuse] of CASES) {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  const src = join(root, 'src');
  mkdirSync(src);
  writeFileSync(join(src, file), `// planted\n${line}\n`);
  let refused = false;
  try { assertForbiddenHostsUnused(cfg, src); } catch { refused = true; }
  rmSync(root, { recursive: true, force: true });
  const ok = refused === refuse;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${refuse ? 'refuses' : 'allows '}  ${label}`);
}
// And the real tree, as it stands, passes.
try { assertForbiddenHostsUnused(cfg); console.log('ok    allows   the repo as it stands'); }
catch (e) { fail++; console.log('FAIL  the repo as it stands:', e.message.split('\n').slice(0, 3).join(' ')); }
if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
