// A pasted profile is written to a card only if it is that card's person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notThisPerson, headerName, nameKey, sameName, withoutMessaging } from '../src/profile-identity.mjs';

const page = (name, headline, firm, rail = '') => `Skip to main content\nHome\nCover photo\n${name}\n\nShe/Her\n\n· 2nd\n\n`
  + `${headline}\n\nAustin, Texas\n\nContact info\n\n${firm}\n\nAbout\nI lead the data team.\n${rail}`;

test('the search led to someone else entirely', () => {
  const p = page('Ann Other', 'CIO at Fabrikam', 'Fabrikam');
  assert.match(notThisPerson(p, 'Jane Contoso', 'Fabrikam'), /Ann Other's page, not Jane Contoso's/);
});

test('same name, another firm: a different person', () => {
  const p = page('Jane Contoso', 'CFO at Northwind Traders', 'Northwind Traders');
  assert.match(notThisPerson(p, 'Jane Contoso', 'Fabrikam Health, Inc.'), /never mentions Fabrikam Health/);
});

test('the right page passes, whatever form the name takes', () => {
  assert.equal(notThisPerson(page('Jane Contoso', 'CIO at Fabrikam Health', 'Fabrikam Health'), 'Dr. Jane Contoso', 'Fabrikam Health, Inc.'), null);
  assert.equal(notThisPerson(page('Joseph Contoso', 'COO', 'Fabrikam'), 'Joe Contoso', 'Fabrikam'), null);
  assert.equal(notThisPerson(page('Ana Tayo-Contoso', 'COO', 'Fabrikam'), 'Ana Tayo Contoso', 'Fabrikam'), null);
  assert.equal(notThisPerson(page('G. Quinn Contoso', 'COO', 'Fabrikam'), 'Quinn Contoso', 'Fabrikam'), null);
  assert.equal(notThisPerson(page('Ned Contoso', 'COO', 'Fabrikam'), 'Edmond "Ned" R. Contoso', 'Fabrikam'), null);
});

test('a firm named only in the suggestion rails does not count', () => {
  const p = page('Jane Contoso', 'CFO at Northwind', 'Northwind', '\nMore profiles for you\nAnn Other\n· 2nd\nCIO at Fabrikam\n');
  assert.match(notThisPerson(p, 'Jane Contoso', 'Fabrikam'), /never mentions Fabrikam/);
});

test('a headline above the degree is not read as a name', () => {
  assert.equal(headerName('Cover photo\nGroup Chief Claims Officer at Fabrikam\n· 3rd\n'), null);
  assert.equal(sameName(nameKey('Jane C.'), 'Jane Contoso'), true);
  assert.equal(sameName(nameKey('Jane C.'), 'Jane Northwind'), false);
});

test('a page with no degree in its header does not take a name from the rails', () => {
  const p = 'Cover photo\nJane Contoso\nCEO at Fabrikam\nFabrikam\nAbout\nI run Fabrikam.\nMore profiles for you\nAnn Other\n· 3rd\nCIO at Northwind\n';
  assert.equal(headerName(p), null);
  assert.equal(notThisPerson(p, 'Jane Contoso', 'Fabrikam'), null);
});

test('the messaging overlay after the footer is never stored', () => {
  const p = 'Cover photo\nJane Contoso\n· 2nd\nCIO at Fabrikam\nAbout\nI run IT.\nLinkedIn Corporation © 2026\nSelect language\nA. Operator\n'
    + 'Messaging You are on the messaging overlay. Press enter to open the list of conversations.\n'
    + 'Close your conversation with A. Operator and Ann Other\nAnn Other sent the following message at 11:34 AM\nPrivate words.\n';
  const out = withoutMessaging(p);
  assert.ok(out.includes('I run IT.'));
  assert.ok(!/Private words|Ann Other|messaging overlay|A\. Operator/.test(out));
  assert.equal(withoutMessaging('no overlay here\n'), 'no overlay here\n');
});
