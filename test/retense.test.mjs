// A speaker record's tense is worked out on the day it is read, not frozen on
// the day the agenda was. A note drafted after a talk was told it was to come.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retense } from '../src/events.mjs';

const claim = 'Ann Lee is speaking at ITC Vegas 2026 (Wednesday, September 30, 2026) on: X';
const session = 'SESSION DATE: Wednesday, September 30, 2026 — which is STILL TO COME as of 2026-09-28.';
const range = 'EVENT DATES: November 9-11, 2026 (2026-11-09 to 2026-11-11), STILL TO COME as of 2026-09-28.';

test('a session day: to come, today, past', () => {
  assert.match(retense(claim, '2026-09-29'), /is speaking at ITC/);
  assert.match(retense(claim, '2026-09-30'), /is speaking today at ITC/);
  assert.match(retense(claim, '2026-10-02'), /spoke at ITC/);
  assert.match(retense(session, '2026-10-02'), /IN THE PAST as of 2026-10-02/);
});

test('a multi-day event with no session day is under way, never today', () => {
  assert.match(retense(range, '2026-11-10'), /UNDER WAY as of 2026-11-10/);
  assert.match(retense(range, '2026-11-12'), /IN THE PAST as of 2026-11-12/);
});

test('text with no speaker record passes through untouched', () => {
  assert.equal(retense('He spoke at length (twice) on: pricing', '2026-10-02'), 'He spoke at length (twice) on: pricing');
});
