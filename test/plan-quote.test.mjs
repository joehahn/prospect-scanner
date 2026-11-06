// A plan's AI line is kept only if it is in the document, word for word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteInText, planDate, normalise } from '../src/plans.mjs';

const PDF = `   •   Integrate state-of-the-art AI into Texas state cyber
       defenses to prevent cybersecurity attacks
   It may assess opportunities for AI-assisted detection and triage, auto-
   mated enrichment, threat intelligence correlation, analyst decision support`;

test('a quote survives PDF line breaks, bullets and a word hyphenated across lines', () => {
  assert.ok(quoteInText('Integrate state-of-the-art AI into Texas state cyber defenses to prevent cybersecurity attacks', PDF));
  assert.ok(quoteInText('opportunities for AI-assisted detection and triage, automated enrichment, threat intelligence correlation', PDF));
});

test('a quote the document does not contain is refused, however close', () => {
  assert.equal(quoteInText('Integrate state-of-the-art AI into Texas state cyber defenses to stop all attacks', PDF), false);
  assert.equal(quoteInText('It will procure AI-assisted detection and triage from a vendor this year', PDF), false);
});

test('a fragment too short to mean anything is not a match', () => {
  assert.equal(quoteInText('detection and triage', PDF), false);
});

test('a plan date is a day, or nothing', () => {
  assert.equal(planDate('2026-06-15'), '2026-06-15');
  assert.equal(planDate('2026-06'), '2026-06-01');
  assert.equal(planDate('2026'), '2026-01-01');
  assert.equal(planDate(''), null);
  assert.equal(planDate('FY 2027-2031'), null);
});

test('curly quotes and case do not decide a match', () => {
  assert.equal(normalise('The State’s “AI” Plan'), normalise("the state's \"ai\" plan"));
});
