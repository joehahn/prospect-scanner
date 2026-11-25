// A customer quoted on a partner's site is not staff, and a legal form from
// outside the target's countries is not admitted (2026-11-24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotedCustomer, foreignForm } from '../src/firms.mjs';

test('titles that name a client or say testimonial are customers', () => {
  assert.ok(quotedCustomer('CEO, Bluewater Medical', 'Acme Consulting'));
  assert.ok(quotedCustomer('VP Finance at Northfield Brands, Inc.', 'Acme Consulting'));
  assert.ok(quotedCustomer('CEO @ Riverpools', 'Acme Consulting'));
  assert.ok(quotedCustomer('CFO of Granite Construction Co', 'Acme Consulting'));
  assert.ok(quotedCustomer('Vice President (client testimonial)', 'Acme Consulting'));
});

test('staff titles stay', () => {
  for (const t of ['President', 'CEO, Acme', 'Vice President of Strategic Accounts', 'VP, Alliances/Channel',
    'Managing Director, Acme International', 'Senior Vice President, Micro', 'Director of Sales & Alliances']) {
    assert.equal(quotedCustomer(t, 'Acme Consulting'), false, t);
  }
});

test('foreign legal forms are caught unless the target covers that country', () => {
  const t = { where: { countries: ['US', 'Canada', 'United Kingdom', 'Ireland'] } };
  assert.equal(foreignForm('Muster IT GmbH', t), 'GmbH');
  assert.equal(foreignForm('Daten AG', t), 'AG');
  assert.equal(foreignForm('Acme Partners LLC', t), null);
  assert.equal(foreignForm('Muster IT GmbH', { where: { countries: ['Germany'] } }), null);
});
