// A name from a pasted profile's sidebar is filed at that profile's organisation
// unless its own title names another. Shared words like a state's name and
// "Department" do not make two agencies one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { otherOrgInTitle } from '../src/org-match.mjs';

const TXDMV = 'Vermont Department of Motor Vehicles';

test('another agency in the title is caught, whatever words it shares', () => {
  assert.equal(otherOrgInTitle('CIO of Vermont Department of Transportation', TXDMV), 'Vermont Department of Transportation');
  assert.equal(otherOrgInTitle('CIO of Vermont Parks and Wildlife Department', TXDMV), 'Vermont Parks and Wildlife Department');
  assert.ok(otherOrgInTitle('Chief Information Officer, State of Montana Department of Public Safety', 'Department of Insurance, State of Montana'));
  assert.ok(otherOrgInTitle('Assistant CIO at Montana Department of Labor Services', 'Department of Facilities Management'));
});

test('a colleague at the same organisation is not blocked', () => {
  assert.equal(otherOrgInTitle('CIO of Vermont Department of Motor Vehicles', TXDMV), null);
  assert.equal(otherOrgInTitle('Head of Product', 'Acme Corp'), null);
  assert.equal(otherOrgInTitle('Director of IT', TXDMV), null);
  assert.equal(otherOrgInTitle('VP Engineering at Contoso', 'Contoso Ltd'), null);
});
