// The name an email address is built from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameParts } from '../src/address-name.mjs';

test('a surname particle stays with the surname', () => {
  assert.deepEqual(nameParts('Jane De Laurentis'), { first: 'jane', last: 'delaurentis', alt: 'laurentis' });
  assert.deepEqual(nameParts('Anna van der Berg'), { first: 'anna', last: 'vanderberg', alt: 'berg' });
  assert.deepEqual(nameParts('Lee Ann Contoso'), { first: 'lee', last: 'contoso' });
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
