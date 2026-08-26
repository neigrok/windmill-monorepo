import test from 'node:test';
import assert from 'node:assert/strict';

import { round } from '../../../src/products/gym/logger/ladder.js';
import {
  hasOpenEntry, isOpenFields, NOT_A_NUMBER, ONE_DECIMAL, OVER_MAX_LOAD, REPS_BAND, SETS_BAND,
  targetEntryOf, targetFieldsOf, targetRefusal, withSignFlipped,
} from '../../../src/products/gym/routines.js';

const fields = (over = {}) => ({ sets: '', reps: '', weight: '', clearRefused: false, ...over });

test('the sheet draws exactly one refusal, computed for the sheet and not one per field', () => {
  // Every one of the three is illegal at once. The sheet says one thing: the topmost.
  const allWrong = fields({ sets: '99', reps: '400', weight: '900' });
  assert.deepEqual(targetRefusal(allWrong), { field: 'sets', message: SETS_BAND });
  // Fix the sets and the next one surfaces — still one, never two.
  assert.deepEqual(targetRefusal({ ...allWrong, sets: '3' }), { field: 'reps', message: REPS_BAND });
  assert.deepEqual(targetRefusal({ ...allWrong, sets: '3', reps: '5' }), { field: 'weight', message: OVER_MAX_LOAD });
  assert.equal(targetRefusal({ ...allWrong, sets: '3', reps: '5', weight: '100' }), null);
  // The sheet's own shape is checked before any field is: a line with no sets and a weight typed on
  // it is one refusal about the line, not a refusal per field.
  assert.deepEqual(targetRefusal(fields({ reps: '9,9,9', weight: '900' })), {
    field: 'sets', message: 'Name the sets first — an open line names neither.',
  });
  assert.deepEqual(targetRefusal(fields({ sets: '3', reps: '5,5,5' })), { field: 'reps', message: ONE_DECIMAL });
  assert.deepEqual(targetRefusal(fields({ sets: '3', weight: '5-' })), { field: 'weight', message: NOT_A_NUMBER });
  // A refused clear is a refusal of the sheet's shape and outranks every field.
  assert.deepEqual(targetRefusal(fields({ sets: '900', reps: '5', clearRefused: true })), {
    field: 'sets', message: 'Clear reps and weight first — an open line names neither.',
  });
});

test('± flips the sign of the text and never leaves a bare minus behind', () => {
  assert.equal(withSignFlipped(fields({ weight: '60' })).weight, '-60');
  assert.equal(withSignFlipped(fields({ weight: '-60' })).weight, '60');
  assert.equal(withSignFlipped(fields({ weight: '22,5' })).weight, '-22,5');
  // Nothing typed, nothing to flip: the press is a no-op, not a `-` the field then has to refuse.
  const empty = fields();
  assert.equal(withSignFlipped(empty), empty);
  assert.equal(withSignFlipped(fields({ weight: '   ' })).weight, '   ');
  // A `-` the lifter typed themselves is cleared by the flip rather than doubled.
  assert.equal(withSignFlipped(fields({ weight: '-' })).weight, '');
  // The flip is a keystroke like any other, so it settles a refused clear.
  assert.equal(withSignFlipped(fields({ weight: '60', clearRefused: true })).clearRefused, false);
  // And a band-assisted target is what comes out the other side.
  const assisted = withSignFlipped(fields({ sets: '3', reps: '8', weight: '20' }));
  assert.equal(targetRefusal(assisted), null);
  assert.equal(targetEntryOf({ exerciseId: 'chin-up' }, assisted).targetWeightKg, -20);
});

test('the target weight is put on the ladder’s grid before it is stored', () => {
  const typed = (weight) => targetEntryOf({ exerciseId: 'back-squat' }, fields({ sets: '3', reps: '5', weight }));
  assert.equal(typed('100,333').targetWeightKg, 100.33);
  assert.equal(typed('-100,336').targetWeightKg, -100.34, 'half away from zero, as the rack rounds');
  assert.equal(typed('102.5').targetWeightKg, 102.5);
  assert.equal(typed('0.005').targetWeightKg, round(0.005));
  // What the rack commits and what the plan asks for are then the same number, never two.
  assert.equal(typed('60,127').targetWeightKg, round(60.127));
  // An empty weight is still `last time` and not a zero.
  assert.equal(typed('').targetWeightKg, null);
});

test('the open line is a property of a LIST and of a SHEET, and each is one question', () => {
  assert.equal(hasOpenEntry([]), false);
  assert.equal(hasOpenEntry([{ exerciseId: 'back-squat', targetSets: 3 }]), false);
  assert.equal(hasOpenEntry([
    { exerciseId: 'back-squat', targetSets: 3 },
    { exerciseId: 'chin-up' },
    { exerciseId: 'deadlift' },
  ]), true, 'two open rows are one sentence, asked once of the whole list');

  assert.equal(isOpenFields(targetFieldsOf({ exerciseId: 'chin-up' })), true);
  assert.equal(isOpenFields(targetFieldsOf({ exerciseId: 'back-squat', targetSets: 3 })), false);
  assert.equal(isOpenFields(fields({ sets: '  ' })), true);
  // The sheet is not open while a clear stands refused: the field kept its value.
  assert.equal(isOpenFields(fields({ sets: '3', reps: '5', clearRefused: true })), false);
});
