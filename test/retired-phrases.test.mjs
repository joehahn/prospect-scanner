import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retiredPhrases, retiredHits } from '../src/checks.mjs';

const voice = `# Someone's voice

## The shape

- a bullet that is not a retired phrase

# Retired phrases

Why they went.

- by the hour
- On Short Notice

# The notes

- not a phrase either
`;

test('retired phrases are read from their own section only', () => {
  assert.deepEqual(retiredPhrases(voice), ['by the hour', 'on short notice']);
  assert.deepEqual(retiredPhrases('# No such section\n- by the hour\n'), []);
});

test('a retired phrase is found whatever its case or spacing', () => {
  const ph = retiredPhrases(voice);
  assert.deepEqual(retiredHits('I take it on By the  hour,\non short notice.', ph), ['by the hour', 'on short notice']);
  assert.deepEqual(retiredHits('A fixed-price build, tested on your data.', ph), []);
});
