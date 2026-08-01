// Tap-to-type, pinned. Two rules are under test. The first is the one Lift got wrong: an invalid
// entry never silently reverts — every refusal below names the problem AND teaches the format, and
// the empty buffer even names the value Cancel would keep. The second is that the pad never writes
// a number the lifter did not type: it opens on the value it was opened from, the first digit
// starts a fresh number rather than appending to that seed, and a key that will not fit is refused
// whole instead of pushing a typed digit off the end.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  backspace, echoOf, isKeyLive, KEYS, MAX_BUFFER, openPad, parseEntry, pressKey, REPS_HINT,
  WEIGHT_HINT,
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
    valid: true, value: 102.5, message: WEIGHT_HINT,
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
  // The case that made this a correctness defect and not a cosmetic one: capping the SIGNED
  // string turned a typed 499 into a committable −49.
  assert.deepEqual(pressKey(pad('00000499'), '±', 'weight'), pad('00000499'));
  assert.deepEqual(parseEntry(pressKey(pad('00000499'), '±', 'weight'), 'weight', 20), {
    valid: true, value: 499, message: WEIGHT_HINT,
  });
});

test('echoOf — the raw buffer read back, with a typographic minus and an em dash for nothing', () => {
  assert.equal(echoOf(pad('')), '—');
  assert.equal(echoOf(pad('105')), '105');
  assert.equal(echoOf(pad('10,2,5')), '10,2,5');
  assert.equal(echoOf(pad('-20')), '−20');
});

test('parseEntry — a valid weight reads comma or point as the same decimal', () => {
  assert.deepEqual(parseEntry(pad('105'), 'weight', 102.5), { valid: true, value: 105, message: WEIGHT_HINT });
  assert.deepEqual(parseEntry(pad('72,5'), 'weight', 102.5), { valid: true, value: 72.5, message: WEIGHT_HINT });
  assert.deepEqual(parseEntry(pad('72.5'), 'weight', 102.5), { valid: true, value: 72.5, message: WEIGHT_HINT });
  assert.deepEqual(parseEntry(pad('-20'), 'weight', 102.5), { valid: true, value: -20, message: WEIGHT_HINT });
  assert.deepEqual(parseEntry(pad('0'), 'weight', 102.5), { valid: true, value: 0, message: WEIGHT_HINT });
  assert.deepEqual(parseEntry(pad('500'), 'weight', 102.5), { valid: true, value: 500, message: WEIGHT_HINT });
  assert.deepEqual(parseEntry(pad('102,505'), 'weight', 0), { valid: true, value: 102.51, message: WEIGHT_HINT });
});

test('parseEntry — every refusal names the problem, and the empty one names what Cancel keeps', () => {
  assert.deepEqual(parseEntry(pad(''), 'weight', 102.5), {
    valid: false, value: null, message: 'Enter a number, or cancel to keep 102.5',
  });
  assert.deepEqual(parseEntry(pad('-'), 'weight', -20), {
    valid: false, value: null, message: 'Enter a number, or cancel to keep −20',
  });
  assert.deepEqual(parseEntry(pad('10,2,5'), 'weight', 102.5), {
    valid: false, value: null, message: 'One decimal point only — 72,5 or 72.5',
  });
  assert.deepEqual(parseEntry(pad('5-'), 'weight', 102.5), {
    valid: false, value: null, message: 'Not a number yet — 72,5 reads as 72.5',
  });
  assert.deepEqual(parseEntry(pad('501'), 'weight', 102.5), {
    valid: false, value: null, message: 'Over 500 kg — check the number',
  });
  assert.deepEqual(parseEntry(pad('-501'), 'weight', 102.5), {
    valid: false, value: null, message: 'Over 500 kg — check the number',
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

test('parseEntry — reps are whole, 0 to 99, and the comma cannot reach them', () => {
  assert.deepEqual(parseEntry(pad('14'), 'reps', 5), { valid: true, value: 14, message: REPS_HINT });
  assert.deepEqual(parseEntry(pad('0'), 'reps', 5), { valid: true, value: 0, message: REPS_HINT });
  assert.deepEqual(parseEntry(pad('99'), 'reps', 5), { valid: true, value: 99, message: REPS_HINT });
  assert.deepEqual(parseEntry(pad('100'), 'reps', 5), {
    valid: false, value: null, message: 'Whole reps, 0 to 99',
  });
  assert.deepEqual(parseEntry(pad('-1'), 'reps', 5), {
    valid: false, value: null, message: 'Whole reps, 0 to 99',
  });
  assert.deepEqual(parseEntry(pad('8.5'), 'reps', 5), {
    valid: false, value: null, message: 'Whole reps, 0 to 99',
  });
  assert.deepEqual(parseEntry(pad(''), 'reps', 8), {
    valid: false, value: null, message: 'Enter a number, or cancel to keep 8',
  });
});
