import test from 'node:test';
import assert from 'node:assert/strict';

import { stepOf, hashWithStep } from '../../../../src/products/roadmap/board/stepAddress.js';

test('stepOf — reads the step from the hash query, and nothing from a hash without one', () => {
  assert.deepEqual(
    [stepOf('#/app/sail?step=wind'), stepOf('#?step=a%20b'), stepOf('#/app/sail'), stepOf(''), stepOf('#/app/new?compose')],
    ['wind', 'a b', null, null, null],
  );
});

test('hashWithStep — sets or drops the step and keeps the route and every other parameter', () => {
  assert.deepEqual([
    hashWithStep('#/app/sail', 'wind'),
    hashWithStep('#/app/sail?step=wind', 'dock'),
    hashWithStep('#/app/sail?step=wind', null),
    hashWithStep('#/app/new?compose', 'a b'),
    hashWithStep('', 'wind'),
    hashWithStep('#?step=wind', null),
  ], [
    '#/app/sail?step=wind',
    '#/app/sail?step=dock',
    '#/app/sail',
    '#/app/new?compose&step=a%20b',
    '#?step=wind',
    '#',
  ]);
});
