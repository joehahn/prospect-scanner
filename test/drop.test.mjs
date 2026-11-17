// The assistant's drop folder: what a saved file is read as.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { readDropped, dropDir } from '../src/drop.mjs';

test('the URL on the first line is the URL, bare or as url=', () => {
  for (const first of ['https://example.org/in/jane-contoso', 'url=https://example.org/in/jane-contoso', 'URL: https://example.org/in/jane-contoso']) {
    const r = readDropped(`${first}\nJane Contoso\n· 2nd\nCIO at Fabrikam`);
    assert.equal(r.url, 'https://example.org/in/jane-contoso');
    assert.match(r.text, /^Jane Contoso/);
  }
});

test('no URL line keeps the whole file as the page', () => {
  const r = readDropped('Jane Contoso\n· 2nd\nCIO at Fabrikam');
  assert.equal(r.url, '');
  assert.match(r.text, /^Jane Contoso/);
});

test('the folder comes from config, with ~ expanded, or not at all', () => {
  assert.equal(dropDir({}), null);
  assert.equal(dropDir({ assistant_drop: { dir: '~/x/drop' } }), `${homedir()}/x/drop`);
});
