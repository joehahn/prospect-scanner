// A lede whose page no longer names the person is removed before a note uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { recheckPages } from '../src/recheck-pages.mjs';

const db = () => {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE evidence (id INTEGER PRIMARY KEY, person_id TEXT, kind TEXT, claim TEXT, source_url TEXT, provenance TEXT);
    CREATE TABLE signals (evidence_id INTEGER); CREATE TABLE gate_results (evidence_id INTEGER);`);
  const ins = d.prepare('INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?)');
  ins.run(1, 'jane', 'announcement', 'Jane Contoso is speaking at X on: Y', 'https://a.example/agenda', 'retrieved');
  ins.run(2, 'jane', 'web_said', 'She said Z', 'https://b.example/post', 'retrieved');
  ins.run(3, 'jane', 'web_said', 'She said W', 'https://down.example/', 'retrieved');
  ins.run(4, 'jane', 'operator_profile', 'Pasted', 'https://www.linkedin.com/in/x', 'operator_supplied');
  ins.run(5, 'jane', 'announcement', 'Jane Contoso is on a panel', 'https://c.example/agenda', 'retrieved');
  d.prepare('INSERT INTO signals VALUES (5)').run();
  return d;
};
const pages = {
  'https://a.example/agenda': { ok: true, html: '<p>Speakers: Ann Other, Lee Fabrikam</p>' },
  'https://b.example/post': { ok: true, html: '<p>by Jane Contoso</p>' },
  'https://down.example/': { ok: false },
  'https://c.example/agenda': { ok: true, html: '<p>Nobody</p>' },
};

test('only a readable page that does not name them loses its record', async () => {
  const d = db();
  const removed = await recheckPages(d, { id: 'jane', name: 'Jane Contoso' }, { fetch: async (u) => pages[u] });
  assert.deepEqual(removed.map((r) => r.id), [1]);
  assert.deepEqual(d.prepare('SELECT id FROM evidence ORDER BY id').all().map((r) => r.id), [2, 3, 4, 5]);
});
