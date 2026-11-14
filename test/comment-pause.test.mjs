// No outreach to someone the operator commented on until a day has passed:
// Friday or weekend comments clear Monday, a Monday comment clears Wednesday.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentPauseEnds } from '../src/comment.mjs';

test('a full day after the comment, rolled to a weekday', () => {
  assert.equal(commentPauseEnds(new Date(2026, 10, 13)), '2026-11-16');   // Fri -> Mon
  assert.equal(commentPauseEnds(new Date(2026, 10, 14)), '2026-11-16');   // Sat -> Mon
  assert.equal(commentPauseEnds(new Date(2026, 10, 15)), '2026-11-16');   // Sun -> Mon
  assert.equal(commentPauseEnds(new Date(2026, 10, 16)), '2026-11-18');   // Mon -> Wed
  assert.equal(commentPauseEnds(new Date(2026, 10, 19)), '2026-11-23');   // Thu -> Mon
});
