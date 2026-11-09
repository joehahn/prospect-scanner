// A sidebar name reaches the ready list only once something confirms the firm.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { unconfirmedEmployer } from '../src/employer.mjs';

function db() {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE people (id TEXT PRIMARY KEY, org_id TEXT, name TEXT, title TEXT, notes TEXT);
    CREATE TABLE evidence (id INTEGER PRIMARY KEY, person_id TEXT, kind TEXT);
    CREATE TABLE verdicts (id INTEGER PRIMARY KEY, person_id TEXT, verdict TEXT);
    CREATE TABLE outreach (id INTEGER PRIMARY KEY, person_id TEXT);
    INSERT INTO orgs VALUES ('its', 'Department of Information Technology Services, State of Northwind');
    INSERT INTO orgs VALUES ('acme', 'Contoso Robotics');
    INSERT INTO orgs VALUES ('cnb', 'Union Savings Bank');`);
  const side = "Surfaced from A. Person's profile page. Not researched.";
  const add = d.prepare('INSERT INTO people VALUES (?, ?, ?, ?, ?)');
  add.run('student', 'its', 'Student', '', side);                       // no title
  add.run('certs', 'its', 'Certs', 'CGCIO, PMP', side);                 // a title naming nothing
  add.run('generic', 'its', 'Generic', 'Director of Information Technology Services', side); // generic words only
  add.run('named', 'its', 'Named', 'Chief Data Officer, State of Northwind', side);         // headline names it
  add.run('wholename', 'cnb', 'Whole', 'SVP, Analytics at Union Savings Bank', side); // every word generic, the name whole
  add.run('otherbank', 'cnb', 'Other', 'SVP, Analytics at a regional bank', side);      // names nothing
  add.run('pasted', 'acme', 'Pasted', '', side);
  add.run('team', 'acme', 'Team', '', side);
  add.run('chosen', 'acme', 'Chosen', '', side);
  add.run('written', 'acme', 'Written', '', side);
  add.run('staff', 'acme', 'Staff', '', 'From the firm team page.');   // not a sidebar name at all
  d.exec(`INSERT INTO evidence (person_id, kind) VALUES ('pasted', 'operator_profile'), ('team', 'staff_listing');
          INSERT INTO verdicts (person_id, verdict) VALUES ('chosen', 'write');
          INSERT INTO outreach (person_id) VALUES ('written');`);
  return d;
}

test('an unconfirmed sidebar name is held back; any confirmation places it', () => {
  const u = unconfirmedEmployer(db());
  assert.deepEqual([...u].sort(), ['certs', 'generic', 'otherbank', 'student']);
});
