// A talk still ahead must not be written as seen: "saw your session" to someone
// speaking in three weeks. The facts reach the drafter dated; this catches the
// wording, which a model check missed once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seenTalkHits } from '../src/checks.mjs';
import { upcomingTalks } from '../src/events.mjs';

const claim = 'Jane Roe is speaking at CDAO Fall 2026 (Tuesday, October 27, 2026) on: Scaling AI';

test('a talk dated after today is ahead; one before is not', () => {
  assert.equal(upcomingTalks([claim], '2026-10-19').length, 1);
  assert.equal(upcomingTalks([claim], '2026-10-28').length, 0);
  assert.equal(upcomingTalks(['Jane Roe raised a fund (2026-10-01)'], '2026-10-19').length, 0);
});

test('"saw your talk" and its kin are caught; "I see you\'re speaking" is not', () => {
  assert.equal(seenTalkHits("Hi Al, saw your CDAO Fall talk next week on scale.").length, 1);
  assert.equal(seenTalkHits('Hi Sona, saw your Biomanufacturing World Summit session on growth.').length, 1);
  assert.equal(seenTalkHits('Caught the panel you are on.').length, 1);
  assert.equal(seenTalkHits("Hi Al, I see you're speaking at CDAO Fall on Tuesday.").length, 0);
  assert.equal(seenTalkHits('I saw you moved to Ipsen in March.').length, 0);
});
