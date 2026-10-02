// A hiring quote blocks a person from the capacity offer, so it has to be a real
// post on the page, about the capability sold. The cheap model filled the field
// with "|", "+null" and its own reasoning; these are the shapes it produced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiringQuote, capabilityTerms } from '../src/hiring.mjs';
import { markAgendaDays } from '../src/events.mjs';

const terms = capabilityTerms(['Head of AI', 'Data Science Director']);
const page = `About me. We're hiring a Data Science Tech Lead to help drive our Machine-Learning
and Generative AI initiatives. Also: we're hiring an IT Service Manager in Seguin!`;

test('a real post for the capability counts', () => {
  assert.ok(hiringQuote("We're hiring a Data Science Tech Lead to help drive our Machine-Learning", page, terms));
});

test('junk, reasoning and invented quotes do not', () => {
  for (const q of ['|', '+null', '{BASED SOLELY ON THE PASTED PROFILE} null', 'None identified. Not hiring.',
    "We're hiring a Head of AI to lead our transformation programme"]) {
    assert.equal(hiringQuote(q, page, terms), null, q);
  }
});

test('a real post for some other skill does not', () => {
  assert.equal(hiringQuote("we're hiring an IT Service Manager in Seguin!", page, terms), null);
});

test('seat words are not capability words', () => {
  assert.ok(!capabilityTerms(['Head of AI']).some((t) => t.test('Head of Marketing')));
});

test('an agenda day heading in the text is marked', () => {
  const m = markAgendaDays('<p>May 11 2026 <b>|</b> <b>Day 1</b></p><p>MAY 12 2026 | Day 2</p>');
  assert.match(m, /\[DAY 2026-05-11\]/);
  assert.match(m, /\[DAY 2026-05-12\]/);
});
