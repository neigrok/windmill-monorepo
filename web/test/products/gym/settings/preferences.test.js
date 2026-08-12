// §I's document, both directions. What is pinned here is every place the wire says one thing by an
// ABSENCE — the rest target that is off, the plate list that is empty rather than unset, the two
// confirmation flags whose defaults point opposite ways — because those are the cases a read written
// with `??` gets subtly wrong and no screenshot ever shows.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BAR_MAX_KG, DEFAULT_PREFERENCES, PLATE_CHOICES, preferenceRefusal, preferencesWrite,
  readPreferences, REST_CHOICES, restLabel, withPlate,
} from '../../../../src/products/gym/settings/preferences.js';

// The defaults are the server's, and they are what a lifter who never opens this screen is served.
// Rest is OFF, and that is the one worth a test of its own: a timer nobody asked for that starts
// beeping in a gym is the thing this product does not do.
test('the defaults are the whole document, with the rest timer off', () => {
  assert.deepEqual(DEFAULT_PREFERENCES, {
    units: 'kg',
    barWeightKg: 20,
    platesKg: [25, 20, 15, 10, 5, 2.5, 1.25],
    restSeconds: null,
    restSound: true,
    confirmHaptic: true,
    confirmSound: false,
  });
  assert.deepEqual(REST_CHOICES, [null, 90, 120, 180]);
  assert.deepEqual(PLATE_CHOICES, DEFAULT_PREFERENCES.platesKg);
  assert.equal(BAR_MAX_KG, 100);
});

test('a document with nothing in it reads as the defaults, whole', () => {
  assert.deepEqual(readPreferences({}), DEFAULT_PREFERENCES);
  assert.deepEqual(readPreferences(null), DEFAULT_PREFERENCES);
  assert.deepEqual(readPreferences(undefined), DEFAULT_PREFERENCES);
});

test('a stored document reads back field for field', () => {
  assert.deepEqual(readPreferences({
    units: 'lb',
    barWeightKg: 20.41,
    platesKg: [20.41, 11.34, 4.54],
    restSeconds: 120,
    restSound: false,
    confirmHaptic: false,
    confirmSound: true,
  }), {
    units: 'lb',
    barWeightKg: 20.41,
    platesKg: [20.41, 11.34, 4.54],
    restSeconds: 120,
    restSound: false,
    confirmHaptic: false,
    confirmSound: true,
  });
});

// AN EMPTY PLATE LIST IS A REAL VALUE and it must not read as the full rack: a gym that owns no
// plates is a different fact from a field nobody sent, and only the second one means the default.
test('an empty plate list is kept, and an absent one is the full rack', () => {
  assert.deepEqual(readPreferences({ platesKg: [] }).platesKg, []);
  assert.deepEqual(readPreferences({}).platesKg, DEFAULT_PREFERENCES.platesKg);
  assert.deepEqual(readPreferences({ platesKg: null }).platesKg, DEFAULT_PREFERENCES.platesKg);
});

test('plates read back heaviest first however they arrived', () => {
  assert.deepEqual(readPreferences({ platesKg: [2.5, 25, 20] }).platesKg, [25, 20, 2.5]);
});

// The two confirmation defaults point opposite ways, which is exactly why an absent field may not be
// read with one rule for both.
test('an absent flag takes its own default, and the two defaults disagree', () => {
  assert.equal(readPreferences({}).confirmHaptic, true);
  assert.equal(readPreferences({}).confirmSound, false);
  assert.equal(readPreferences({}).restSound, true);
  assert.equal(readPreferences({ confirmHaptic: false }).confirmHaptic, false);
  assert.equal(readPreferences({ confirmSound: true }).confirmSound, true);
  assert.equal(readPreferences({ restSound: false }).restSound, false);
});

test('an absent rest target is off, and off is the only way it is spelled', () => {
  assert.equal(readPreferences({}).restSeconds, null);
  assert.equal(readPreferences({ restSeconds: 90 }).restSeconds, 90);
});

// A unit this build does not know reads as kilograms rather than as itself: the store clamps the
// same way, and a screen drawing an unknown word beside every weight would be worse than one drawing
// the unit the numbers are actually in.
test('an unknown unit reads as kilograms', () => {
  assert.equal(readPreferences({ units: 'stone' }).units, 'kg');
  assert.equal(readPreferences({ units: 7 }).units, 'kg');
  assert.equal(readPreferences({ units: 'lb' }).units, 'lb');
});

test('the write carries the whole document, and spells "off" by leaving the field out', () => {
  assert.deepEqual(preferencesWrite(DEFAULT_PREFERENCES), {
    units: 'kg',
    barWeightKg: 20,
    platesKg: [25, 20, 15, 10, 5, 2.5, 1.25],
    restSound: true,
    confirmHaptic: true,
    confirmSound: false,
  });
  assert.equal('restSeconds' in preferencesWrite(DEFAULT_PREFERENCES), false);
  assert.equal(preferencesWrite({ ...DEFAULT_PREFERENCES, restSeconds: 180 }).restSeconds, 180);
});

// The round trip: what the store answers, written back, is byte-for-byte what it would store again.
test('a stored document written back is the same document', () => {
  const stored = { units: 'lb', barWeightKg: 15, platesKg: [20, 10], restSeconds: 90, restSound: false, confirmHaptic: false, confirmSound: true };
  assert.deepEqual(preferencesWrite(readPreferences(stored)), stored);
});

test('rest targets are spelled as a clock, and off is a word', () => {
  assert.equal(restLabel(null), 'off');
  assert.equal(restLabel(90), '1:30');
  assert.equal(restLabel(120), '2:00');
  assert.equal(restLabel(180), '3:00');
  assert.equal(restLabel(15), '0:15');
  assert.equal(restLabel(900), '15:00');
});

test('a plate toggles in and out, and the rack stays heaviest first', () => {
  assert.deepEqual(withPlate([25, 20, 15], 15), [25, 20]);
  assert.deepEqual(withPlate([25, 15], 20), [25, 20, 15]);
  assert.deepEqual(withPlate([], 1.25), [1.25]);
  assert.deepEqual(withPlate([1.25], 1.25), []);
});

// The store's sentence is what a lifter is shown, because it names the band the value fell outside.
// The code beside it is never read here — a refusal reworded overnight must still say something
// true, and a client that recognised the English would say nothing at all.
test('a refusal speaks in the store’s own words, and finishes itself when there are none', () => {
  assert.equal(preferenceRefusal({ detail: 'a plate weighs from 0.01 to 100 kg', code: 'plate-weight' }), 'a plate weighs from 0.01 to 100 kg');
  assert.equal(preferenceRefusal({ detail: '', code: 'plate-weight' }), 'that setting didn’t save — the log didn’t answer. Try again in a moment');
  assert.equal(preferenceRefusal(null), 'that setting didn’t save — the log didn’t answer. Try again in a moment');
});
