// At an investor, the staffing question is asked of the portfolio companies, not the fund.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { investorNote } from '../src/investor-note.mjs';

test('an investor gets the portfolio-company frame; other firms get nothing', () => {
  assert.match(investorNote({ kind: 'investor', name: 'Northwind Capital' }),
    /^Northwind Capital is an investor\. The buyer is one of its portfolio companies/);
  assert.match(investorNote({ kind: 'investor', name: 'X' }), /unknown, which rules no offer out/);
  assert.equal(investorNote({ kind: 'end_client', name: 'Contoso' }), '');
  assert.equal(investorNote(null), '');
});
