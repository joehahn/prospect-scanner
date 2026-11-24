import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regionOf, regionLabel } from '../src/region.mjs';
import { fieldsNear } from '../src/paste-match.mjs';

const cfg = { icp: { geography: ['US'], home_metros: ['Springfield'], home_region: ['Illinois', 'IL'],
  home_metro_label: 'Springfield metro', home_region_label: 'Illinois' } };

test('a place reads as its region, abroad first', () => {
  assert.equal(regionOf({ location: 'Springfield, Illinois, United States' }, cfg), 'home_metro');
  assert.equal(regionOf({ location: 'Greater Chicago Area' }, cfg), 'home_region');
  assert.equal(regionOf({ location: 'Greater Boston' }, cfg), 'home_country');
  assert.equal(regionOf({ location: 'Dubai, United Arab Emirates' }, cfg), 'middle_east');
  assert.equal(regionOf({ location: 'Greater Paris Metropolitan Region' }, cfg), 'europe');
  assert.equal(regionOf({ location: 'Toronto, Ontario, Canada' }, cfg), 'canada');
  assert.equal(regionOf({ location: 'Singapore' }, cfg), 'elsewhere');
  assert.equal(regionOf({}, cfg), null);
});

test('labels name the home tiers from config', () => {
  assert.equal(regionLabel('home_metro', cfg), 'Springfield metro');
  assert.equal(regionLabel('home_region', cfg), 'Illinois, outside Springfield metro');
  assert.equal(regionLabel(null, cfg), 'No location on file');
});

test('a pasted header reads a Metroplex or a bare Greater metro as the location', () => {
  for (const place of ['Dallas-Fort Worth Metroplex', 'Greater Boston']) {
    const text = `Pat Example\n· 2nd\nHead of Operations at Example Co\n${place}\n·\nContact info\n`;
    assert.equal(fieldsNear(text, 'Pat Example').location, place);
  }
});

test('the location is read above the first Contact info when the header name differs from the card', () => {
  const text = 'Skip to search\nHome\nPatricia Q. Example, CFA\n· 3rd\nPartner, Head of Operations\nUnited States\n·\nContact info\nPeople you may know\nSomeone Else\nLondon, England, United Kingdom\n';
  assert.equal(fieldsNear(text, 'Pat Example').location, 'United States');
  const none = 'Skip to search\nPat Example\n· 2nd\nHead of Operations at Example Co\n·\nContact info\n';
  assert.equal(fieldsNear(none, 'Pat Example').location, undefined);
});
