import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOGGER_REPS_MAX, LOGGER_REPS_MIN, NOT_A_NUMBER, ONE_DECIMAL, OVER_MAX_LOAD, parseEntry, REPS_BAND, REPS_HINT,
  WEIGHT_UNIT,
} from '../../../../src/products/gym/logger/entry.js';

const pad = (text) => ({ text, seeded: false });

test('the line under a valid weight is the unit alone, and under valid reps the one word', () => {
  assert.equal(WEIGHT_UNIT, 'kg');
  assert.equal(REPS_HINT, 'whole reps');
});

test('parseEntry — a valid weight reads comma or point as the same decimal', () => {
  assert.deepEqual(parseEntry(pad('105'), 'weight', 102.5), { valid: true, value: 105, message: WEIGHT_UNIT });
  assert.deepEqual(parseEntry(pad('72,5'), 'weight', 102.5), { valid: true, value: 72.5, message: WEIGHT_UNIT });
  assert.deepEqual(parseEntry(pad('72.5'), 'weight', 102.5), { valid: true, value: 72.5, message: WEIGHT_UNIT });
  assert.deepEqual(parseEntry(pad('-20'), 'weight', 102.5), { valid: true, value: -20, message: WEIGHT_UNIT });
  assert.deepEqual(parseEntry(pad('0'), 'weight', 102.5), { valid: true, value: 0, message: WEIGHT_UNIT });
  assert.deepEqual(parseEntry(pad('500'), 'weight', 102.5), { valid: true, value: 500, message: WEIGHT_UNIT });
  assert.deepEqual(parseEntry(pad('102,505'), 'weight', 0), { valid: true, value: 102.51, message: WEIGHT_UNIT });
});

test('parseEntry — every refusal names the problem, and the empty one names what Cancel keeps', () => {
  assert.deepEqual(parseEntry(pad(''), 'weight', 102.5), {
    valid: false, value: null, message: 'Enter a number, or cancel to keep 102.5',
  });
  assert.deepEqual(parseEntry(pad('-'), 'weight', -20), {
    valid: false, value: null, message: 'Enter a number, or cancel to keep −20',
  });
  assert.deepEqual(parseEntry(pad('10,2,5'), 'weight', 102.5), {
    valid: false, value: null, message: ONE_DECIMAL,
  });
  assert.deepEqual(parseEntry(pad('5-'), 'weight', 102.5), {
    valid: false, value: null, message: NOT_A_NUMBER,
  });
  assert.deepEqual(parseEntry(pad('501'), 'weight', 102.5), {
    valid: false, value: null, message: OVER_MAX_LOAD,
  });
  assert.deepEqual(parseEntry(pad('-501'), 'weight', 102.5), {
    valid: false, value: null, message: OVER_MAX_LOAD,
  });
});

test('parseEntry — reps are whole, 1 to 99, and the comma cannot reach them', () => {
  // This module holds the LIVE LOGGER's band; the routine target's is 1–100, in routines.js.
  assert.equal(LOGGER_REPS_MIN, 1);
  assert.equal(LOGGER_REPS_MAX, 99);
  assert.deepEqual(
    [ONE_DECIMAL, NOT_A_NUMBER, OVER_MAX_LOAD, REPS_BAND],
    ['One decimal point only.', 'That is not a number yet.', 'Over 500 kg — check the number.',
      'Whole reps, 1 to 99.'],
  );
  assert.deepEqual(parseEntry(pad('14'), 'reps', 5), { valid: true, value: 14, message: REPS_HINT });
  assert.deepEqual(parseEntry(pad('1'), 'reps', 5), { valid: true, value: 1, message: REPS_HINT });
  assert.deepEqual(parseEntry(pad('99'), 'reps', 5), { valid: true, value: 99, message: REPS_HINT });
  assert.deepEqual(parseEntry(pad('0'), 'reps', 5), {
    valid: false, value: null, message: REPS_BAND,
  });
  assert.deepEqual(parseEntry(pad('100'), 'reps', 5), {
    valid: false, value: null, message: REPS_BAND,
  });
  assert.deepEqual(parseEntry(pad('-1'), 'reps', 5), {
    valid: false, value: null, message: REPS_BAND,
  });
  assert.deepEqual(parseEntry(pad('8.5'), 'reps', 5), {
    valid: false, value: null, message: REPS_BAND,
  });
  assert.deepEqual(parseEntry(pad(''), 'reps', 8), {
    valid: false, value: null, message: 'Enter a number, or cancel to keep 8',
  });
});
