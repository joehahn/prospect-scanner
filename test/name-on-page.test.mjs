// A web fact is filed under a person only if its page names them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameOnPage, surnameOf } from '../src/name-on-page.mjs';

test('an article by someone else is not about this person', () => {
  const page = '<meta name="author" content="Ann Other, Chief Information Officer"><h1>Governing AI Before It Governs Us</h1>';
  assert.equal(nameOnPage(page, 'Jane Contoso'), false);
  assert.equal(nameOnPage(page, 'Ann Other'), true);
});

test('credentials, accents, case and hyphens do not hide a name', () => {
  assert.equal(surnameOf('Kim Northwind, Ph.D.'), 'northwind');
  assert.equal(surnameOf('Lee R. Fabrikam, PE, SE'), 'fabrikam');
  assert.equal(nameOnPage('<p>Ana Núñez Fábrega</p>', 'Ana Nunez-Fabrega'), true);
  assert.equal(nameOnPage('<p>JANE CONTOSO spoke</p>', 'Jane Contoso'), true);
});

test('a surname inside a longer word is not a match', () => {
  assert.equal(nameOnPage('<p>Contosoville Council</p>', 'Jane Contoso'), false);
});
