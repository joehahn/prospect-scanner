// A public body is bought differently from a company, and the name is the only
// thing known about one filed from a conference agenda. Fictional names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksPublic } from '../src/public-body.mjs';

test('cities, counties, agencies and police read as public', () => {
  for (const n of ['City of Springfield', 'Town of Riverbend', 'Springfield Police Department', 'Shelbyville County',
    'Department of Revenue, State of Utopia', 'Vermont Lottery Advisory Board', 'Riverbend Independent School District',
    'Lakeside Transit Authority', 'Office of the Chief Data Officer', 'Kansas Highway Patrol']) {
    assert.equal(looksPublic(n), true, n);
  }
});

test('companies named for a place do not', () => {
  for (const n of ['Springfield County Container Group', 'Riverbend Village Outlets', 'Texas Widget Company',
    'Utopia Mutual Insurance Group', 'Virginia Credit Union', 'County Line Partners LLC', 'Georgia Paper Corp']) {
    assert.equal(looksPublic(n), false, n);
  }
});
