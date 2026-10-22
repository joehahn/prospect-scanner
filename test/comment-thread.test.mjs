// A reply to the operator's comment reaches the drafter as first-hand history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { operatorSaidLines } from '../src/operator-said.mjs';

const db = () => {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE comments (id INTEGER PRIMARY KEY, person_id TEXT, post_date TEXT, summary TEXT,
    posted_text TEXT, posted_at TEXT, replied INTEGER, reply_text TEXT, replied_at TEXT)`);
  return d;
};

test('a posted comment and its reply become one dated line', () => {
  const d = db();
  d.prepare(`INSERT INTO comments VALUES (1, 'ann', '2026-10-14', 'Matching at the front door',
    'It is doable.', '2026-10-21T17:05:00Z', 1, 'Agreed, and the back end too.', '2026-10-21')`).run();
  const line = operatorSaidLines(d, 'ann');
  assert.match(line, /^- 2026-10-21, a public exchange on their LinkedIn post of 2026-10-14/);
  assert.match(line, /commented "It is doable\."; they replied 2026-10-21: "Agreed, and the back end too\."/);
});

test('a drafted but unposted comment is not history', () => {
  const d = db();
  d.prepare(`INSERT INTO comments (id, person_id, posted_text) VALUES (1, 'ann', NULL)`).run();
  assert.equal(operatorSaidLines(d, 'ann'), '');
});

test('a reply with no words recorded says so rather than inventing them', () => {
  const d = db();
  d.prepare(`INSERT INTO comments (id, person_id, posted_text, posted_at, replied)
    VALUES (1, 'ann', 'Hi.', '2026-10-21T00:00:00Z', 1)`).run();
  assert.match(operatorSaidLines(d, 'ann'), /they replied \(their words not recorded\)/);
});
