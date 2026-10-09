// Drafting learns from the notes the operator sent, chosen per recipient, and
// alternates with the fixed set so the two can be compared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { changed, splitVoice, updateWording, chooseArm, LIVE_CHALLENGER } from '../src/voice-examples.mjs';

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

test('new drafts alternate fixed and the challenger; a revision keeps its arm; an override wins', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE drafts (id INTEGER PRIMARY KEY, revised_from INTEGER, examples TEXT)');
  assert.equal(chooseArm(db), LIVE_CHALLENGER);
  db.prepare('INSERT INTO drafts (id, examples) VALUES (1, ?)').run(JSON.stringify({ arm: LIVE_CHALLENGER }));
  assert.equal(chooseArm(db), 'fixed');
  db.prepare('INSERT INTO drafts (id, examples) VALUES (2, ?)').run('{"arm":"fixed"}');
  assert.equal(chooseArm(db), LIVE_CHALLENGER);
  // A revision of draft 1 keeps its arm, and does not count as a new note.
  assert.equal(chooseArm(db, { prior: { id: 1 } }), LIVE_CHALLENGER);
  db.prepare('INSERT INTO drafts (id, revised_from, examples) VALUES (3, 1, ?)').run(JSON.stringify({ arm: LIVE_CHALLENGER }));
  assert.equal(chooseArm(db), LIVE_CHALLENGER);
  assert.equal(chooseArm(db, { override: 'picked' }), 'picked');
});

test('an instruction quoting a prospect\'s own page never travels to another draft', async () => {
  const { portable } = await import('../src/voice-examples.mjs');
  assert.equal(portable('drop the number, lead with the diligence angle'), true);
  assert.equal(portable('his profile says [WRITE IN RAP] so add a P.S.'), false);
  assert.equal(portable('the about section reads like a pitch; answer it'), false);
  assert.equal(portable('x'.repeat(201)), false);
});

test('sentence edits: rewrites, cuts and additions, greeting ignored', async () => {
  const { sentenceEdits } = await import('../src/voice-examples.mjs');
  const e = sentenceEdits('Greetings Ann,\n\nYour firm put ten pilots out to bid. I build that. A long aside nobody needs here.',
    'Greetings Ann,\n\nYour firm put ten AI pilots out to bid this month. I build that. Happy to talk.');
  assert.deepEqual(e.map((x) => [x.kind, x.opening]), [['rewrote', true], ['cut', false], ['added', false]]);
});

test('email, InMail and LinkedIn message learn from one pool; a connection note only from its own', async () => {
  const { poolOf } = await import('../src/voice-examples.mjs');
  const pool = ['email', 'linkedin_inmail', 'linkedin_message'];
  for (const ch of pool) assert.deepEqual(poolOf(ch), pool);
  assert.deepEqual(poolOf('linkedin_connect_note'), ['linkedin_connect_note']);
});

test('a note recorded as sent today joins the example pool tomorrow, not mid-day', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openDb } = await import('../src/db.mjs');
  const { recentExamples } = await import('../src/voice-examples.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'pool-day-'));
  const db = openDb(join(dir, 'test.db'));
  try {
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO people (id, org_id, name) VALUES ('target', 'org-t', 'T')`).run();
    const add = db.prepare(`INSERT INTO drafts (id, person_id, org_id, channel, version, model, body,
      sent_text, created_at, sent_recorded_at) VALUES (?, ?, ?, 'email', 1, 'm', 'DRAFT\n---\nhi', 'hi', ?, ?)`);
    add.run(1, 'a', 'org-a', '2026-10-01T10:00:00Z', null);                     // recorded before the column
    add.run(2, 'b', 'org-b', '2026-10-02T10:00:00Z', '2026-10-02T11:00:00Z');   // yesterday
    add.run(3, 'c', 'org-c', '2026-10-03T08:00:00Z', '2026-10-03T12:00:00Z');   // today, noon
    const ids = (cut) => recentExamples(db, { personId: 'target', channel: 'email', recordedBefore: cut })
      .map((x) => x.id);
    assert.deepEqual(ids('2026-10-03T05:00:00Z'), [1, 2]);
    assert.deepEqual(ids(null), [1, 2, 3]);
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('a note with a long ask behind it is kept, without that ask', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { openDb } = await import('../src/db.mjs');
  const { recentExamples } = await import('../src/voice-examples.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'pool-ask-'));
  const db = openDb(join(dir, 'test.db'));
  try {
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO people (id, org_id, name) VALUES ('target', 'org-t', 'T')`).run();
    const add = db.prepare(`INSERT INTO drafts (id, person_id, org_id, channel, version, model, body,
      sent_text, created_at, revise_note) VALUES (?, 'a', 'org-a', 'email', 1, 'm', 'DRAFT\n---\nhi', ?, '2026-10-02T10:00:00Z', ?)`);
    add.run(1, null, 'x'.repeat(250));            // a long ask, quoting the draft
    add.run(2, null, 'say I build AI');           // a short one
    add.run(3, 'hi there', null);                 // what was sent
    const [x] = recentExamples(db, { personId: 'target', channel: 'email' });
    assert.equal(x.id, 3);
    assert.deepEqual(x.asks, ['say I build AI']);
    assert.equal(x.asksWithheld, 1);
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
