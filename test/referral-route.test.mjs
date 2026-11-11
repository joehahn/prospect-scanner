// A budget owner with a high referral score is pitched as a buyer, not asked
// for a name (2026-11-11). Someone without the budget still gets the ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyerForOrg } from '../src/config.mjs';

const cfg = { buyers: [{ id: 'referral_ask' }, { id: 'senior_capacity' }, { id: 'build_direct' }] };

test('a referral node without the budget gets the referral ask', () => {
  const c = buyerForOrg(cfg, { kind: 'end_client', referralValue: 0.6 });
  assert.equal(c.id, 'referral_ask');
});

test('a referral node who owns the budget is not routed to the referral ask', () => {
  const c = buyerForOrg(cfg, { kind: 'end_client', referralValue: 0.6, capabilityAuthority: 'owns' });
  assert.notEqual(c?.id, 'referral_ask');
});
