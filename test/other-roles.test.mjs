// The companies a person holds a role at besides the job reach the read and the drafter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureBoardSeats, roleWords, boardLines } from '../src/boards.mjs';

const db = () => {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE people (id TEXT PRIMARY KEY); CREATE TABLE orgs (id TEXT PRIMARY KEY);'
    + ' CREATE TABLE evidence (id INTEGER PRIMARY KEY, org_id TEXT, person_id TEXT, kind TEXT, claim TEXT)');
  d.prepare("INSERT INTO people VALUES ('ann')").run();
  return d;
};

test('role words keep the four roles and drop the rest', () => {
  assert.equal(roleWords('Advisor and investor'), 'advisor, investor');
  assert.equal(roleWords('Board member'), 'board');
  assert.equal(roleWords('Co-founder'), 'founder');
  assert.equal(roleWords('Employee'), '');
});

test('an advisory role from a profile is a line the read and the drafter see', () => {
  const d = db();
  ensureBoardSeats(d);
  d.prepare(`INSERT INTO board_seats (person_id, company, status, source_url, first_seen, role)
    VALUES ('ann', 'Northwind Titles', 'current', 'https://example.com/ann', '2026-10-22', 'advisor, investor')`).run();
  d.prepare(`INSERT INTO board_seats (person_id, company, status, source_url, first_seen, role)
    VALUES ('ann', 'Old Co', 'past', 'https://example.com/ann', '2026-10-22', 'board')`).run();
  const lines = boardLines(d, 'ann');
  assert.match(lines, /^- Northwind Titles \(advisor, investor\) \(what it does is not on file\)/);
  assert.doesNotMatch(lines, /Old Co/);
});

test('a board_seats table from before roles gains the column, as a board seat', () => {
  const d = db();
  d.exec(`CREATE TABLE board_seats (person_id TEXT NOT NULL, company TEXT NOT NULL, company_id TEXT,
    status TEXT NOT NULL, source_url TEXT NOT NULL, first_seen TEXT NOT NULL, PRIMARY KEY (person_id, company))`);
  d.prepare(`INSERT INTO board_seats VALUES ('ann', 'Contoso Bank', NULL, 'current', 'https://example.com', '2026-09-28')`).run();
  ensureBoardSeats(d);
  assert.match(boardLines(d, 'ann'), /Contoso Bank \(board\)/);
});
