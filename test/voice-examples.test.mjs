// Drafting learns from the notes the operator sent, chosen per recipient, and
// alternates with the fixed set so the two can be compared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { changed, splitVoice, updateWording, chooseArm } from '../src/voice-examples.mjs';

test('words changed is measured on the note, not the NOTES section', () => {
  const draft = 'Greetings Ann,\n\nOne two three four.\n\nNOTES\n-----\nlots of reasoning here for the operator';
  assert.equal(changed(draft, 'Greetings Ann,\n\nOne two three four.'), 0);
  assert.ok(changed(draft, 'Greetings Ann,\n\nOne two five six.') > 0.3);
});

test('voice.md splits into prose and its notes', () => {
  const v = '# Voice\n\nThe shape.\n\n---\n\n# The notes\n\nNine he sent.\n\n### A\n\nnote a\n\n### B\n\nnote b\n';
  const { prose, notes } = splitVoice(v);
  assert.match(prose, /The shape\./);
  assert.doesNotMatch(prose, /---\s*$/);
  assert.deepEqual(notes.map((n) => n.split('\n')[0]), ['### A', '### B']);
});

test('retired wording is replaced before a sent note becomes an example', () => {
  const sup = [{ was: 'Ten years at Acme.', now: 'Ten years at Acme, the last four leading audit.' }];
  assert.equal(updateWording('Hi. Ten years at Acme. Bye.', sup), 'Hi. Ten years at Acme, the last four leading audit. Bye.');
  assert.equal(updateWording('untouched', undefined), 'untouched');
});

test('new drafts alternate arms; a revision keeps its arm; an override wins', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE drafts (id INTEGER PRIMARY KEY, revised_from INTEGER, examples TEXT)');
  assert.equal(chooseArm(db), 'picked');
  db.prepare('INSERT INTO drafts (id, examples) VALUES (1, ?)').run('{"arm":"picked"}');
  assert.equal(chooseArm(db), 'fixed');
  db.prepare('INSERT INTO drafts (id, examples) VALUES (2, ?)').run('{"arm":"fixed"}');
  assert.equal(chooseArm(db), 'picked');
  // A revision of draft 1 stays picked, and does not count as a new note.
  assert.equal(chooseArm(db, { prior: { id: 1 } }), 'picked');
  db.prepare('INSERT INTO drafts (id, revised_from, examples) VALUES (3, 1, ?)').run('{"arm":"picked"}');
  assert.equal(chooseArm(db), 'picked');
  assert.equal(chooseArm(db, { override: 'fixed' }), 'fixed');
});
