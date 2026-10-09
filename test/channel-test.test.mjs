// The channel test alternates email and LinkedIn among comparable people, and
// counts replies only on sends old enough to have had one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { assign, armOf, atFirm, channelResults, familyOf } from '../src/channel-test.mjs';

const fresh = () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE people (id TEXT PRIMARY KEY);
    CREATE TABLE outreach (id INTEGER PRIMARY KEY, person_id TEXT, channel TEXT, sent_at TEXT, service_pitched TEXT);
    CREATE TABLE responses (id INTEGER PRIMARY KEY, outreach_id INTEGER, sentiment TEXT)`);
  for (const id of ['a', 'b', 'c', 'd']) db.prepare('INSERT INTO people (id) VALUES (?)').run(id);
  return db;
};

test('arms alternate, starting with email, and nobody is assigned twice', () => {
  const db = fresh();
  assert.deepEqual(assign(db, ['a', 'b', 'c']).map((x) => x.arm), ['email', 'linkedin', 'email']);
  assert.deepEqual(assign(db, ['c', 'd']).map((x) => [x.person_id, x.arm]), [['d', 'linkedin']]);
  assert.equal(armOf(db, 'a'), 'email');
  assert.equal(armOf(db, 'zz'), null);
});

test('channels fold into two families', () => {
  assert.equal(familyOf('email'), 'email');
  assert.equal(familyOf('linkedin_and_email'), 'email');
  assert.equal(familyOf('linkedin_connect_note'), 'linkedin');
  assert.equal(familyOf('linkedin_inmail'), 'linkedin');
  assert.equal(familyOf(null), null);
});

test('replies count only on mature sends; bounces are counted apart', () => {
  const db = fresh();
  assign(db, ['a', 'b']);
  const now = Date.parse('2026-11-01T12:00:00Z');
  const send = (id, person, channel, at) => db.prepare('INSERT INTO outreach (id, person_id, channel, sent_at) VALUES (?, ?, ?, ?)').run(id, person, channel, at);
  send(1, 'a', 'email', '2026-10-01');                 // mature, replied
  send(2, 'b', 'linkedin_connect_note', '2026-10-01'); // mature, silent
  send(3, 'c', 'email', '2026-10-30');                 // too fresh, not in the test
  send(4, 'd', 'email', '2026-10-02');                 // mature, bounced, not in the test
  db.prepare("INSERT INTO responses (outreach_id, sentiment) VALUES (1, 'positive'), (3, 'positive'), (4, 'bounced')").run();
  const r = channelResults(db, { now });
  assert.deepEqual(r.all.email, { sent: 3, mature: 2, replied: 1, bounced: 1 });
  assert.deepEqual(r.all.linkedin, { sent: 1, mature: 1, replied: 0, bounced: 0 });
  assert.deepEqual(r.test.email, { sent: 1, mature: 1, replied: 1, bounced: 0 });
});

test('only an address at the firm\'s own domain puts someone in the test', () => {
  assert.equal(atFirm('jdoe@acme.com', 'acme.com'), true);
  assert.equal(atFirm('jdoe@uk.acme.com', 'https://www.acme.com/'), true);
  assert.equal(atFirm('jdoe@yahoo.com', 'acme.com'), false);
  assert.equal(atFirm('jdoe@notacme.com', 'acme.com'), false);
  assert.equal(atFirm('jdoe@acme.com', null), false);
  assert.equal(atFirm(null, 'acme.com'), false);
});
