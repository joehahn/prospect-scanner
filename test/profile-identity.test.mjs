// A pasted profile is written to a card only if it is that card's person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notThisPerson, headerName, nameKey, sameName, withoutMessaging, firmShare } from '../src/profile-identity.mjs';

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

test('one shared word does not name a firm as fully as its own name', () => {
  const p = page('Jo P.', 'Quality Leader at Fabrikam Industrial Works', 'Fabrikam Industrial Works')
    + 'Spoke on: Smart Automotive Manufacturing Using AI\n';
  assert.ok(firmShare(p, 'Fabrikam Industrial Works') > firmShare(p, 'Contoso (Automotive Trade Alliance)'));
  assert.equal(firmShare(p, ''), 0);
});

test('outside the network: a middle initial before the surname initial, and a long-form first name', () => {
  assert.equal(notThisPerson(page('Ann M C.', 'CPO at Fabrikam', 'Fabrikam'), 'Ann Contoso', 'Fabrikam'), null);
  assert.equal(notThisPerson(page('Michael C.', 'Head of Procurement', 'Fabrikam'), 'Mike Contoso', 'Fabrikam'), null);
  assert.match(notThisPerson(page('Ann M D.', 'CPO at Fabrikam', 'Fabrikam'), 'Ann Contoso', 'Fabrikam'), /not Ann Contoso's/);
  assert.match(notThisPerson(page('Paul C.', 'CPO at Fabrikam', 'Fabrikam'), 'Ann Contoso', 'Fabrikam'), /not Ann Contoso's/);
});

test('a surname a letter off or spaced differently is the same person', () => {
  assert.ok(sameName(nameKey('Jane Contossa'), 'Jane Contosa'));
  assert.ok(sameName(nameKey('Dr. Jane Alfabrik'), 'Dr. Jane Al Fabrik'));
  assert.ok(!sameName(nameKey('Jane Smyth'), 'Jane Smith'), 'short surnames stay exact');
  assert.ok(!sameName(nameKey('Jane Contossa'), 'Ann Contosa'), 'the first name still has to match');
  assert.equal(notThisPerson(page('Jane Contossa', 'CIO at Fabrikam', 'Fabrikam'), 'Jane Contosa', 'Fabrikam'), null);
});

test('a hidden surname: the header is a first name and dots', async () => {
  const { hiddenSurnameFirst } = await import('../src/profile-identity.mjs');
  assert.equal(hiddenSurnameFirst('Jane ..'), 'jane');
  assert.equal(hiddenSurnameFirst('Jane Contoso'), null);
  assert.equal(hiddenSurnameFirst('Frantz F.'), null);
  assert.equal(nameKey('Jane ..'), null);
  const p = page('Jane ..', 'Supply Chain Lead', 'Fabrikam');
  assert.equal(notThisPerson(p, 'Jane Contoso', 'Fabrikam'), null);
});

test('a profile address with nothing of the name in it is not theirs', async () => {
  const { slugFits } = await import('../src/profile-identity.mjs');
  assert.equal(slugFits('https://www.linkedin.com/in/jane-c/', 'Jane Contoso'), true);
  assert.equal(slugFits('https://www.linkedin.com/in/afabrik09/', 'Ann Fabrikam'), true);
  assert.equal(slugFits('https://www.linkedin.com/in/annother', 'Jane Contoso'), false);
  assert.equal(slugFits('https://www.linkedin.com/in/ACoAABxyz/', 'Jane Contoso'), true);
});

test('a Gulf location is read from the header', async () => {
  const { fieldsNear } = await import('../src/paste-match.mjs');
  const p = 'Cover photo\nJane Contoso\n\n· 2nd\n\nSupply Chain Lead\n\nDubai, United Arab Emirates\n\n·\n\nContact info\n';
  assert.equal(fieldsNear(p, 'Jane Contoso').country, 'United Arab Emirates');
  const r = 'Cover photo\nJane Contoso\n\n· 2nd\n\nCIO\n\nBucharest, Romania\n\nContact info\n';
  assert.equal(fieldsNear(r, 'Jane Contoso').location, undefined);
});

test('a card that says Tom matches the page that says Thomas', () => {
  assert.equal(sameName(nameKey('Thomas Contoso'), 'Tom Contoso'), true);
  assert.equal(notThisPerson(page('Thomas Contoso', 'Managing Partner at Fabrikam', 'Fabrikam'), 'Tom Contoso', 'Fabrikam'), null);
});

test('an everyday word of the firm name in a stranger\'s About is not the firm', () => {
  const p = page('Ann C.', 'Art Commissions | Strategic Advice', 'Toronto, Ontario',
    '\nI am an executive heading up a new position in a fast market.');
  assert.match(notThisPerson(p, 'Ann Contoso', 'New Fabrikam Power Authority') ?? '', /never mentions/);
});
