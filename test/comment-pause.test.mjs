// No outreach for two full business days after the operator comments on a post.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentPauseEnds } from '../src/comment.mjs';

test('two full weekdays after the comment, then outreach may resume', () => {
  assert.equal(commentPauseEnds(new Date(2026, 10, 13)), '2026-11-18');   // Fri: Mon, Tue held
  assert.equal(commentPauseEnds(new Date(2026, 10, 14)), '2026-11-18');   // Sat
  assert.equal(commentPauseEnds(new Date(2026, 10, 16)), '2026-11-19');   // Mon: Tue, Wed held
  assert.equal(commentPauseEnds(new Date(2026, 10, 19)), '2026-11-24');   // Thu: Fri, Mon held
});
