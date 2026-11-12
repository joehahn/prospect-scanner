// The send-time check (src/send-check.mjs), on the shapes of mistake found in
// the sent history on 2026-11-12, and on ordinary notes that must pass. On the
// 427 recorded sends it flagged 4, each a real mistake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendProblems } from '../src/send-check.mjs';

const person = { name: 'Omar Haddad' };

test('a clean note passes', () => {
  assert.deepEqual(sendProblems('Hi Omar,\n\nI read your talk on claims triage. I build AI for that kind of work.\n\nJoe',
    { person, orgName: 'County of Marin' }), []);
});

test('internal notes pasted with the note are caught', () => {
  const t = 'Hi Omar, a short note.\n\nNOTES\n-----\n- My read on whether to send: expect a polite reply at best.';
  assert.ok(sendProblems(t, { person }).length >= 2);
});

test('a word typed twice is caught, a doubled greeting too', () => {
  assert.equal(sendProblems('Hi Omar, I saw it on on Monday.', { person }).length, 1);
  assert.equal(sendProblems('HiHi Omar, hello.', { person }).length, 1);
  assert.deepEqual(sendProblems('Hi Omar, I know that that is hard.', { person }), []);
});

test('another county than the one on file is caught', () => {
  const p = sendProblems('Hi Omar, congratulations on starting as CIO at Lakeshore County.', { person, orgName: 'County of Riverbend' });
  assert.equal(p.length, 1);
  assert.deepEqual(sendProblems('Hi Omar, congratulations on Riverbend County.', { person, orgName: 'County of Riverbend' }), []);
});

test('a greeting to someone else is caught, a title or nickname prefix is not', () => {
  assert.equal(sendProblems('Hi Ana, a note.', { person }).length, 1);
  assert.deepEqual(sendProblems('Hi Dr. Haddad, a note.', { person }), []);
  assert.deepEqual(sendProblems('Hi Om, a note.', { person }), []);
});
