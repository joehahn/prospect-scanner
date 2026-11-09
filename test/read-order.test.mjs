// Waiting agendas are read nearest event first, so speakers arrive with a dated reason to write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readOrder } from '../src/conferences.mjs';

test('next 60 days soonest first, then the last 30 days, then later, undated, far off, old', () => {
  const today = '2026-11-09';
  const when = ['March 11, 2027', 'October 1, 2026', 'December 1, 2026', '', 'November 3, 2026',
    'November 20, 2026', 'January 20, 2027'];
  const order = [...when].sort((a, b) => readOrder(a, today) - readOrder(b, today));
  assert.deepEqual(order, ['November 20, 2026', 'December 1, 2026', 'November 3, 2026',
    'January 20, 2027', '', 'March 11, 2027', 'October 1, 2026']);
});
