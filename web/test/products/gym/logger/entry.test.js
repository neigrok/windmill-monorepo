import test from 'node:test';
import assert from 'node:assert/strict';

import {
  backspace, echoOf, isKeyLive, KEYS, LOGGER_REPS_MAX, LOGGER_REPS_MIN, MAX_BUFFER, NOT_A_NUMBER,
  ONE_DECIMAL, openPad, OVER_MAX_LOAD, parseEntry, pressKey, REPS_BAND, REPS_HINT, WEIGHT_UNIT,
} from '../../../../src/products/gym/logger/entry.js';

const pad = (text) => ({ text, seeded: false });

test('the pad is twelve keys in one order, with two stood down in reps mode', () => {
  assert.deepEqual(KEYS, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '±', '0', ',']);
  assert.equal(isKeyLive(',', 'weight'), true);
  assert.equal(isKeyLive('±', 'weight'), true);
  assert.equal(isKeyLive(',', 'reps'), false);
  assert.equal(isKeyLive('±', 'reps'), false);
  assert.equal(isKeyLive('7', 'reps'), true);
  assert.deepEqual(pressKey(pad('1'), ',', 'reps'), pad('1'));
  assert.deepEqual(pressKey(pad('1'), '±', 'reps'), pad('1'));
});

test('the pad opens on the value it was opened from, valid and committable', () => {
  assert.deepEqual(openPad(102.5), { text: '102.5', seeded: true });
  assert.deepEqual(openPad(-20), { text: '-20', seeded: true });
  assert.deepEqual(openPad(0), { text: '0', seeded: true });
  assert.deepEqual(openPad(5), { text: '5', seeded: true });
  assert.deepEqual(parseEntry(openPad(102.5), 'weight', 102.5), {
    valid: true, value: 102.5, message: WEIGHT_UNIT,
  });
  assert.deepEqual(parseEntry(openPad(5), 'reps', 5), { valid: true, value: 5, message: REPS_HINT });
  assert.equal(echoOf(openPad(102.5)), '102.5');
  assert.equal(echoOf(openPad(-20)), '−20');
});

test('the first digit starts a fresh number; ± and backspace edit the seed instead', () => {
  assert.deepEqual(pressKey(openPad(102.5), '6', 'weight'), { text: '6', seeded: false });
  assert.deepEqual(pressKey(pressKey(openPad(102.5), '6', 'weight'), '0', 'weight'), {
    text: '60', seeded: false,
  });
  assert.deepEqual(pressKey(openPad(102.5), ',', 'weight'), { text: ',', seeded: false });
  assert.deepEqual(pressKey(openPad(20), '±', 'weight'), { text: '-20', seeded: false });
  assert.deepEqual(backspace(openPad(102.5)), { text: '102.', seeded: false });
  assert.deepEqual(pressKey(openPad(14), '9', 'reps'), { text: '9', seeded: false });
});

test('pressKey — ± toggles the sign, the buffer caps at eight, backspace takes one back', () => {
  assert.deepEqual(pressKey(pad(''), '1', 'weight'), pad('1'));
  assert.deepEqual(pressKey(pad('10'), ',', 'weight'), pad('10,'));
  assert.deepEqual(pressKey(pad('10,'), '5', 'weight'), pad('10,5'));
  assert.deepEqual(pressKey(pad('20'), '±', 'weight'), pad('-20'));
  assert.deepEqual(pressKey(pad('-20'), '±', 'weight'), pad('20'));
  assert.equal(MAX_BUFFER, 8);
  assert.deepEqual(backspace(pad('102,5')), pad('102,'));
  assert.deepEqual(backspace(pad('')), pad(''));
});

test('a key that will not fit is refused whole — the sign never eats a typed digit', () => {
  assert.deepEqual(pressKey(pad('12345678'), '9', 'weight'), pad('12345678'));
  assert.deepEqual(pressKey(pad('12345678'), '±', 'weight'), pad('12345678'));
  assert.deepEqual(pressKey(pad('1234567'), '±', 'weight'), pad('-1234567'));
  assert.deepEqual(pressKey(pad('-1234567'), '±', 'weight'), pad('1234567'));
  assert.deepEqual(pressKey(pad('00000499'), '±', 'weight'), pad('00000499'));
  assert.deepEqual(parseEntry(pressKey(pad('00000499'), '±', 'weight'), 'weight', 20), {
    valid: true, value: 499, message: WEIGHT_UNIT,
  });
});

test('echoOf — the raw buffer read back, with a typographic minus and an em dash for nothing', () => {
  assert.equal(echoOf(pad('')), '—');
  assert.equal(echoOf(pad('105')), '105');
  assert.equal(echoOf(pad('10,2,5')), '10,2,5');
  assert.equal(echoOf(pad('-20')), '−20');
});

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

test('the alarm state is reachable only by a buffer the lifter emptied themselves', () => {
  const opened = openPad(102.5);
  assert.equal(parseEntry(opened, 'weight', 102.5).valid, true);
  const cleared = [...'102.5'].reduce((held) => backspace(held), opened);
  assert.deepEqual(cleared, { text: '', seeded: false });
  assert.deepEqual(parseEntry(cleared, 'weight', 102.5), {
    valid: false, value: null, message: 'Enter a number, or cancel to keep 102.5',
  });
  assert.equal(echoOf(cleared), '—');
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
