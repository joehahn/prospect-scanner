import { test } from 'node:test';
import assert from 'node:assert/strict';

test('drifted section headings are put back in the form the parsers read', async () => {
  const { canonicalSections } = await import('../src/note-text.mjs');
  const drifted = '**OFFER**\n\nsmall_shop_starter\nSUBJECT\nA subject line\nDRAFT\nHi Pat,\n\nNOTES:\n- why';
  const out = canonicalSections(drifted);
  assert.match(out, /^SUBJECT\s*\n-+\s*\n(.+?)\s*$/m);
  assert.equal(out.match(/^SUBJECT\s*\n-+\s*\n(.+?)\s*$/m)[1], 'A subject line');
  assert.match(out, /^OFFER\s*\n-+\s*\n\s*small_shop_starter/m);
  assert.match(out, /^NOTES\n-----\n- why/m);
  // Already canonical: unchanged.
  const ok = 'OFFER\n-----\nx\n\nDRAFT\n-----\nHi\n\nNOTES\n-----\n- n';
  assert.equal(canonicalSections(ok), ok);
});
