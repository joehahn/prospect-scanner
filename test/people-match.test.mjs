// A sidebar name already on file is not filed again: under a nickname at the
// same firm, or at the firm the person really works for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { nameParts, pageNames, samePersonOnFile, titlesAgree } from '../src/people-match.mjs';

const db = new Database(':memory:');
db.exec('CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT, title TEXT, org_id TEXT)');
const add = db.prepare('INSERT INTO people VALUES (?, ?, ?, ?)');
add.run('ronald_roe', 'Ronald Roe', 'Founder', 'acme');
add.run('raj_kumar', 'Raj Kumar', 'Managing Director, Head of Value Creation and Chief Digital Officer', 'fund_a');
add.run('john_smith', 'John Smith', 'Chief Financial Officer', 'fund_a');
add.run('jane_doe_cpa', 'Jane Doe, CPA', 'Chief Operating Officer', 'bank');

test('names are read past aliases, credentials and suffixes', () => {
  assert.deepEqual(nameParts('Rajveer (Raj) Kumar'), { firsts: ['rajveer', 'raj'], last: 'kumar' });
  assert.equal(nameParts('Jane Doe, CPA').last, 'doe');
  assert.equal(nameParts('Sam Lee Jr.').last, 'lee');
  assert.equal(nameParts('Andrew'), null);
});

test('a nickname at the same firm is the same person', () => {
  assert.equal(samePersonOnFile(db, { name: 'Ron Roe', orgId: 'acme' })?.id, 'ronald_roe');
  assert.equal(samePersonOnFile(db, { name: 'Jane Doe', orgId: 'bank' })?.id, 'jane_doe_cpa');
  assert.equal(samePersonOnFile(db, { name: 'Bill Roe', orgId: 'acme' }), null);
});

test('at another firm the title has to agree too', () => {
  const hit = samePersonOnFile(db, { name: 'Rajveer (Raj) Kumar',
    title: 'Managing Director, Head of Value Creation and Chief Digital Office', orgId: 'fund_b' });
  assert.equal(hit?.id, 'raj_kumar');
  assert.equal(hit.sameOrg, false);
  assert.equal(samePersonOnFile(db, { name: 'John Smith', title: 'VP Sales', orgId: 'fund_b' }), null);
  assert.equal(samePersonOnFile(db, { name: 'John Smith', orgId: 'fund_b' }), null);
});

test('titles agree on shared words, not on one', () => {
  assert.equal(titlesAgree('Chief Information Officer', 'CIO and Chief Information Officer'), true);
  assert.equal(titlesAgree('Chief Financial Officer', 'Chief Operating Officer'), false);
});

test('a page names the person by surname, or as LinkedIn shows a stranger: first name and initial', () => {
  assert.equal(pageNames('Omar H.\nHe/Him · 2nd\nState Chief Data Officer', 'Omar Haddad'), true);
  assert.equal(pageNames('Profile of Ana Haddad', 'Omar Haddad'), true);
  assert.equal(pageNames('Omar Haddock, CDO', 'Omar Haddad'), false);
  assert.equal(pageNames('Omar K.\nChief Data Officer', 'Omar Haddad'), false);
  assert.equal(pageNames('Jane Smith, CFO', 'Omar Haddad'), false);
});
