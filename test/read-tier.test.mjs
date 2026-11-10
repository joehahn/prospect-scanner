// The kind of event goes before its date, the reduced kind takes a capped
// share of a day's reads, and an agenda more than a year past is set aside.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTier, pickToRead, longPast } from '../src/conferences.mjs';

const mech = { read_first: ['operating partner', 'procurement'], read_last: ['gov', 'city'], read_last_share: 0.2 };
const ev = (id, name, when_text = '') => ({ id, name, when_text, organizer: '' });

test('first, middle and last kinds', () => {
  assert.equal(readTier(ev(1, 'Operating Partners Forum'), mech), 0);
  assert.equal(readTier(ev(2, 'GovAI Coalition Summit'), mech), 2);
  assert.equal(readTier(ev(3, 'Smart Cities Week'), mech), 1);       // "city" is not a prefix of "cities"
  assert.equal(readTier(ev(4, 'Data Innovation Summit'), mech), 1);
  assert.equal(readTier(ev(5, 'Forgovernance Days'), mech), 1);      // a prefix only at a word's start
});

test('the reduced kind takes its share, and is read when nothing else waits', () => {
  const today = '2026-11-10';
  const rows = [
    ev(1, 'GovAI Summit', 'December 9, 2026'), ev(2, 'City Tech Day', 'December 1, 2026'),
    ev(3, 'Gov Data Forum', 'November 20, 2026'), ev(4, 'Data Summit', 'March 3, 2027'),
    ev(5, 'Procurement Leaders', 'May 5, 2027'), ev(6, 'Retail Week', 'December 2, 2026'),
  ];
  const got = pickToRead(rows, mech, 5, today).map((r) => r.id);
  assert.deepEqual(got, [5, 6, 4, 3]);                      // one government event of five
  assert.deepEqual(pickToRead([rows[0], rows[1]], mech, 5, today).map((r) => r.id), [2]);
});

test('an agenda more than a year past is set aside', () => {
  const today = '2026-11-10';
  assert.equal(longPast(ev(1, 'AMS Annual Meeting', 'January 2017'), today), true);
  assert.equal(longPast(ev(2, 'Agenda 2020'), today), true);
  assert.equal(longPast(ev(3, '2025 Agenda 25 March 2025'), today), false); // last year is still read
  assert.equal(longPast(ev(4, 'Summit', 'October 1, 2026'), today), false);
  assert.equal(longPast(ev(5, 'Summit'), today), false);
});
