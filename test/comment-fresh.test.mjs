// Which pastes are worth a comment call. The filter runs on every paste and
// decides whether money is spent, so its edges are pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activitySection, postAges, hasFreshPost } from '../src/comment.mjs';

const NOW = new Date('2026-10-17T12:00:00Z');
const page = (activity) => `Jane Doe\nCOO at Example\n\nAbout\nRuns things.\n\nActivity\n\n1,200 followers\n${activity}\n\nExperience\n\nCOO\nExample\nMay 12, 2021 - Present\n`;

test('the section stops at Experience, so job dates are not post dates', () => {
  const s = activitySection(page('Oct 1\nA post.'));
  assert.ok(s.includes('Oct 1'));
  assert.ok(!s.includes('May 12, 2021'));
});

test('no Activity section, no call', () => {
  assert.equal(hasFreshPost('Jane Doe\nCOO\n\nExperience\nOct 15\n', '2026-10-16T00:00:00Z', NOW), false);
});

test('a dated post inside the window counts; one outside does not', () => {
  assert.equal(hasFreshPost(page('Jane Doe\nOct 13\nWe paused 47 agent jobs.'), '2026-10-16T00:00:00Z', NOW), true);
  assert.equal(hasFreshPost(page('Jane Doe\nSep 23\nHiring.'), '2026-10-16T00:00:00Z', NOW), false);
});

test('relative ages count back from the paste, not from today', () => {
  // Pasted 2026-10-05: "3d" is Oct 2, fifteen days before NOW.
  assert.equal(hasFreshPost(page('2d — an essay'), '2026-10-05T00:00:00Z', NOW), false);
  // Pasted yesterday: "3d" is four days ago.
  assert.equal(hasFreshPost(page('3d • Edited\nan essay'), '2026-10-16T12:00:00Z', NOW), true);
});

test('a yearless date after the paste is last year, and an explicit year is kept', () => {
  const ages = postAges('Activity\nDec 5\nDec 5, 2023\n10mo\n', '2026-10-16T00:00:00Z', NOW);
  assert.ok(ages[0] > 300 && ages[0] < 320);   // Dec 5, 2025
  assert.ok(ages[1] > 1000);
  assert.ok(ages[2] > 290);
});

test('a year on its own is not a day of the month', () => {
  assert.deepEqual(postAges('Activity\nMay 2020 - Present\n', '2026-10-16T00:00:00Z', NOW), []);
});
