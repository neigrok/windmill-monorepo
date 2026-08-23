import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PREFERENCES, preferenceRefusal, preferencesWrite, readPreferences, REST_CHOICES,
  restLabel,
} from '../../../../src/products/gym/settings/preferences.js';

test('the defaults are the whole document, with the rest timer off', () => {
  assert.deepEqual(DEFAULT_PREFERENCES, {
    units: 'kg',
    restSeconds: null,
    restSound: true,
    confirmHaptic: true,
    confirmSound: false,
  });
  assert.deepEqual(REST_CHOICES, [null, 90, 120, 180]);
});

test('a document with nothing in it reads as the defaults, whole', () => {
  assert.deepEqual(readPreferences({}), DEFAULT_PREFERENCES);
  assert.deepEqual(readPreferences(null), DEFAULT_PREFERENCES);
  assert.deepEqual(readPreferences(undefined), DEFAULT_PREFERENCES);
});

test('a stored document reads back field for field', () => {
  assert.deepEqual(readPreferences({
    units: 'lb',
    restSeconds: 120,
    restSound: false,
    confirmHaptic: false,
    confirmSound: true,
  }), {
    units: 'lb',
    restSeconds: 120,
    restSound: false,
    confirmHaptic: false,
    confirmSound: true,
  });
});

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

test('an unknown unit reads as kilograms', () => {
  assert.equal(readPreferences({ units: 'stone' }).units, 'kg');
  assert.equal(readPreferences({ units: 7 }).units, 'kg');
  assert.equal(readPreferences({ units: 'lb' }).units, 'lb');
});

test('the write carries the whole document, and spells "off" by leaving the field out', () => {
  assert.deepEqual(preferencesWrite(DEFAULT_PREFERENCES), {
    units: 'kg',
    restSound: true,
    confirmHaptic: true,
    confirmSound: false,
  });
  assert.equal('restSeconds' in preferencesWrite(DEFAULT_PREFERENCES), false);
  assert.equal(preferencesWrite({ ...DEFAULT_PREFERENCES, restSeconds: 180 }).restSeconds, 180);
});

test('a stored document written back is the same document', () => {
  const stored = { units: 'lb', restSeconds: 90, restSound: false, confirmHaptic: false, confirmSound: true };
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

test('a refusal speaks in the store’s own words, and finishes itself when there are none', () => {
  assert.equal(preferenceRefusal({ detail: 'a rest target runs from 15 to 900 seconds', code: 'rest-target' }), 'a rest target runs from 15 to 900 seconds');
  assert.equal(preferenceRefusal({ detail: '', code: 'rest-target' }), 'that setting didn’t save — the log didn’t answer. Try again in a moment');
  assert.equal(preferenceRefusal(null), 'that setting didn’t save — the log didn’t answer. Try again in a moment');
});
