// The name an email address is built from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameParts } from '../src/address-name.mjs';

test('a surname particle stays with the surname', () => {
  assert.deepEqual(nameParts('Jane De Laurentis'), { first: 'jane', last: 'delaurentis', alt: 'laurentis' });
  assert.deepEqual(nameParts('Anna van der Berg'), { first: 'anna', last: 'vanderberg', alt: 'berg' });
});

test('a middle word may be half of the given name, so it is offered as one', () => {
  assert.deepEqual(nameParts('Lee Ann Contoso'), { first: 'lee', last: 'contoso', altFirst: 'leeann' });
  assert.deepEqual(nameParts('Wei Ming Fabrikam'), { first: 'wei', last: 'fabrikam', altFirst: 'weiming' });
  assert.deepEqual(nameParts('Jane Doe'), { first: 'jane', last: 'doe' });
});

test('a particle that leads is a first name, not a surname', () => {
  assert.deepEqual(nameParts('De Contoso'), { first: 'de', last: 'contoso' });
});

test('apostrophes, accents and honorifics do not reach the address', () => {
  assert.deepEqual(nameParts("Sean O'Brien"), { first: 'sean', last: 'obrien' });
  assert.deepEqual(nameParts('Ana Núñez'), { first: 'ana', last: 'nunez' });
  assert.deepEqual(nameParts('Ida Fabrikaß'), { first: 'ida', last: 'fabrikass' });
  assert.deepEqual(nameParts('Dr. Jane Doe'), { first: 'jane', last: 'doe' });
});
