// A partner firm with no AI bench is offered hours to bring to its clients
// (2026-11-24). A firm that sells AI delivery, or one whose site is unread,
// is still offered nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyerForOrg } from '../src/config.mjs';

const cfg = { buyers: [{ id: 'senior_capacity' }, { id: 'build_direct' }] };

test('a partner that sells no AI is routed to senior capacity', () => {
  const c = buyerForOrg(cfg, { kind: 'delivery_firm', org: { sells_ai_delivery: 0, sells_ai_advisory: 0 } });
  assert.equal(c.id, 'senior_capacity');
});

test('a firm that sells AI delivery gets no offer', () => {
  assert.equal(buyerForOrg(cfg, { kind: 'delivery_firm', org: { sells_ai_delivery: 1, sells_ai_advisory: 0 } }).id, null);
});

test('a delivery firm whose site is unread gets no offer', () => {
  assert.equal(buyerForOrg(cfg, { kind: 'delivery_firm', org: {} }).id, null);
});
