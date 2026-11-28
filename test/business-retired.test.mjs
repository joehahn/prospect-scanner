// A retired offer or target stays in business.yml as the record, and nothing
// pitches, judges or searches with it. A credential with `use_when` reaches the
// drafter with its condition attached. Fictional business throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const R = decodeURIComponent(new URL('../', import.meta.url).pathname);
const { loadBusiness, liveOffers, describeForJudge, credentialText, readBusinessFile } =
  await import(R + 'src/business.mjs');

const YML = `
firm: { name: Fabrikam Advisory }
you:
  credentials:
    - "Ten years in a regional bank's audit team"
    - fact: "a marine biologist for a decade"
      use_when: "the reader runs a science team"
offers:
  - { name: Audit Hour, price: 300, for: anyone }
  - { name: Vendor Watch, price: 4000, for: buyers of vendor tools, status: retired, replaces: [vendor_watch] }
targets:
  - { name: Regional lenders, description: small lenders }
  - { name: Vendor buyers, description: firms that just bought a tool, status: retired }
`;
const path = join(mkdtempSync(join(tmpdir(), 'biz-')), 'business.yml');
writeFileSync(path, YML);
const b = loadBusiness({}, null, { path });

test('a retired offer is kept for its past sends but not offered or judged', () => {
  assert.equal(b.offers.length, 2);
  assert.deepEqual(liveOffers(b).map((o) => o.name), ['Audit Hour']);
  assert.ok(!describeForJudge(b).includes('Vendor Watch'));
});

test('a retired target leaves discovery and judging, and is kept as the record', () => {
  assert.deepEqual(b.targets.map((t) => t.name), ['Regional lenders']);
  assert.deepEqual(b.retired_targets.map((t) => t.name), ['Vendor buyers']);
  assert.ok(!describeForJudge(b).includes('Vendor buyers'));
});

test('a credential with use_when carries its condition; a plain one is unchanged', () => {
  const [plain, cond] = b.you.credentials.map(credentialText);
  assert.equal(plain, "Ten years in a regional bank's audit team");
  assert.match(cond, /^a marine biologist for a decade \[.*only when the reader runs a science team.*not a default line\]$/);
});

test('a credential object without use_when is refused', () => {
  const bad = join(mkdtempSync(join(tmpdir(), 'biz-')), 'business.yml');
  writeFileSync(bad, YML.replace('      use_when: "the reader runs a science team"\n', ''));
  assert.throws(() => readBusinessFile(bad), /credentials\[1\]/);
});
