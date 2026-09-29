// A firm `npm run firms` takes back out must leave nothing behind.
//
// Candidates are vetted in the book, because enrich and gate work on org rows,
// and every one that fails is removed. A leftover person, evidence row or gate
// result would put a firm nobody admitted onto a page. This builds a firm the
// way a vet does, purges it, and checks the book is as it was, foreign keys
// included. It also checks the seat matcher that decides who is kept.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const R = decodeURIComponent(new URL('../', import.meta.url).pathname);
const { openDb, purgeOrg, purgePeople } = await import(R + 'src/db.mjs');
const { inSeat } = await import(R + 'src/business.mjs');

let fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); if (!ok) fail++; };

const dir = mkdtempSync(join(tmpdir(), 'firms-purge-'));
const db = openDb(join(dir, 't.db'));
const now = new Date().toISOString();
const firm = (id) => db.prepare(`INSERT INTO orgs (id, name, first_seen, kind) VALUES (?, ?, ?, 'staffing')`)
  .run(id, id, now);
const person = (id, org, title) => db.prepare(`INSERT INTO people (id, org_id, name, title) VALUES (?, ?, ?, ?)`)
  .run(id, org, id, title);
const evidence = (org, personId) => db.prepare(`INSERT INTO evidence (org_id, person_id, kind, claim, source_url,
  retrieved_at) VALUES (?, ?, 'staff_listing', ?, 'https://example.com/team', ?)`)
  .run(org, personId, `${personId ?? org} listed`, now).lastInsertRowid;

// A firm that stays, so a purge that deletes too much shows up.
firm('keeper'); person('keeper_p', 'keeper', 'Senior Recruiter'); evidence('keeper', 'keeper_p');

// A firm as a vet leaves it: people, evidence, a gate result citing a listing.
firm('gone');
person('gone_a', 'gone', 'Technical Recruiter');
person('gone_b', 'gone', 'Controller');
const cited = evidence('gone', 'gone_b');
evidence('gone', null);
db.prepare(`INSERT INTO gate_results (org_id, gate_id, outcome, reason, evidence_id)
  VALUES ('gone', 'capability_already_staffed', 'pass', 'n/a', ?)`).run(cited);

// Removing a person a gate result cites clears the citation, not the result.
purgePeople(db, ['gone_b']);
check(!db.prepare(`SELECT 1 FROM people WHERE id = 'gone_b'`).get(), 'the person is removed');
check(db.prepare(`SELECT evidence_id FROM gate_results WHERE org_id = 'gone'`).get()?.evidence_id === null,
  'a gate result citing their listing keeps its verdict and loses the citation');

purgeOrg(db, 'gone');
const left = ['orgs', 'people', 'evidence', 'gate_results']
  .map((t) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${t === 'orgs' ? 'id' : 'org_id'} = 'gone'`).get().n);
check(left.every((n) => n === 0), 'nothing of the purged firm is left');
check(db.prepare(`SELECT COUNT(*) n FROM people WHERE org_id = 'keeper'`).get().n === 1
  && db.prepare(`SELECT COUNT(*) n FROM evidence WHERE org_id = 'keeper'`).get().n === 1,
  'the other firm is untouched');
check(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'no dangling foreign keys');

const t = { seats: ['recruiter', 'account manager', 'founder'] };
check(inSeat(t, 'SENIOR RECRUITER'), 'a seat matches whatever the case');
check(inSeat(t, 'Strategic Account  Manager'), 'a two-word seat matches across spacing');
check(!inSeat(t, 'Controller'), 'a title outside the seats does not');
check(!inSeat(t, 'Recruitment Marketing Lead'), 'a near word does not');
check(!inSeat({}, 'Recruiter'), 'a target with no seats matches nobody');

db.close();
rmSync(dir, { recursive: true, force: true });
if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log('\nall passed');
