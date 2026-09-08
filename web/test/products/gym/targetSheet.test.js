import test from 'node:test';
import assert from 'node:assert/strict';

import { round } from '../../../src/products/gym/logger/ladder.js';
import {
  isOpenFields, NOT_A_NUMBER, ONE_DECIMAL, OVER_MAX_LOAD, REPS_BAND, SETS_BAND,
  targetEntryOf, targetFieldsOf, targetRefusal, withHead, withRow, withSets, withSignFlipped,
} from '../../../src/products/gym/routines.js';

const fields = (over = {}) => ({ sets: '', rows: [], addRefused: false, ...over });
const row = (reps, weight) => ({ reps, weight });

test('the sheet draws exactly one refusal, computed for the sheet and not one per field', () => {
  // Every field is illegal at once. The sheet says one thing: the topmost.
  const allWrong = fields({ sets: '99', rows: [row('400', '900')] });
  assert.deepEqual(targetRefusal(allWrong), { field: 'sets', row: null, message: SETS_BAND });
  // Fix the count and the next one surfaces — still one, never two.
  assert.deepEqual(targetRefusal({ ...allWrong, sets: '1' }), { field: 'reps', row: 0, message: REPS_BAND });
  assert.deepEqual(targetRefusal(withRow({ ...allWrong, sets: '1' }, 0, 'reps', '5')), { field: 'weight', row: 0, message: OVER_MAX_LOAD });
  assert.equal(targetRefusal(fields({ sets: '1', rows: [row('5', '100')] })), null);
  // The rows carry the fault, each under its own row, the topmost first.
  const two = fields({ sets: '2', rows: [row('9,9,9', '900'), row('5-', '5-')] });
  assert.deepEqual(targetRefusal(two), { field: 'reps', row: 0, message: ONE_DECIMAL });
  assert.deepEqual(targetRefusal(withRow(two, 0, 'reps', '5')), { field: 'weight', row: 0, message: OVER_MAX_LOAD });
  assert.deepEqual(targetRefusal(withRow(withRow(two, 0, 'reps', '5'), 0, 'weight', '')), { field: 'reps', row: 1, message: NOT_A_NUMBER });
  // A ladder with a fault on it is not judged while the count is empty: the commit is the open line.
  assert.equal(targetRefusal(withSets(two, '')), null);
  // A twenty-first row never landed, and that outranks every field.
  assert.deepEqual(targetRefusal({ ...two, addRefused: true }), { field: 'add', row: null, message: SETS_BAND });
});

test('± flips the sign of one row’s load text and never leaves a bare minus behind', () => {
  const one = (weight) => fields({ sets: '1', rows: [row('8', weight)] });
  assert.equal(withSignFlipped(one('60'), 0).rows[0].weight, '-60');
  assert.equal(withSignFlipped(one('-60'), 0).rows[0].weight, '60');
  assert.equal(withSignFlipped(one('22,5'), 0).rows[0].weight, '-22,5');
  // Nothing typed, nothing to flip: the press is a no-op, not a `-` the field then has to refuse.
  const empty = one('');
  assert.equal(withSignFlipped(empty, 0), empty);
  assert.deepEqual(withSignFlipped(one('   '), 0), one('   '));
  // A `-` the lifter typed themselves is cleared by the flip rather than doubled.
  assert.equal(withSignFlipped(one('-'), 0).rows[0].weight, '');
  // One row, not the ladder: the other rows keep their sign.
  const two = fields({ sets: '2', rows: [row('8', '20'), row('8', '20')] });
  assert.deepEqual(withSignFlipped(two, 1).rows, [row('8', '20'), row('8', '-20')]);
  // The flip is a keystroke like any other, so it settles a refused Add set.
  assert.equal(withSignFlipped({ ...two, addRefused: true }, 0).addRefused, false);
  // And a band-assisted target is what comes out the other side.
  const assisted = withSignFlipped(fields({ sets: '1', rows: [row('8', '20')] }), 0);
  assert.equal(targetRefusal(assisted), null);
  assert.deepEqual(targetEntryOf({ exerciseId: 'chin-up' }, assisted).sets, [{ reps: 8, weightKg: -20 }]);
  // The head's own flip is the copy-down of the flipped text.
  assert.deepEqual(withHead(two, 'weight', '-20').rows, [row('8', '-20'), row('8', '-20')]);
  // The head's `±` is the same flip written into every ladder row; a head reading `varies` has no
  // sign to flip.
  assert.deepEqual(withSignFlipped(two).rows, [row('8', '-20'), row('8', '-20')]);
  assert.deepEqual(withSignFlipped(withSignFlipped(two)).rows, two.rows);
  assert.deepEqual(withSignFlipped(withRow(two, 1, 'weight', '25')).rows, [row('8', '20'), row('8', '25')]);
});

test('a target load is put on the ladder’s grid before it is stored', () => {
  const typed = (weight) => targetEntryOf({ exerciseId: 'back-squat' }, fields({ sets: '1', rows: [row('5', weight)] })).sets[0].weightKg;
  assert.equal(typed('100,333'), 100.33);
  assert.equal(typed('-100,336'), -100.34, 'half away from zero, as the rack rounds');
  assert.equal(typed('102.5'), 102.5);
  assert.equal(typed('0.005'), round(0.005));
  // What the rack commits and what the plan asks for are then the same number, never two.
  assert.equal(typed('60,127'), round(60.127));
  // An empty load is still `last time` and not a zero: the key is absent.
  assert.equal(typed(''), undefined);
});

test('the open line is a property of the SHEET, and it is one question', () => {
  assert.equal(isOpenFields(targetFieldsOf({ exerciseId: 'chin-up' })), true);
  assert.equal(isOpenFields(targetFieldsOf({ exerciseId: 'back-squat', sets: [{}] })), false);
  assert.equal(isOpenFields(fields({ sets: '  ' })), true);
  // The rows do not make a line: a hidden ladder under an empty count is still the open line.
  assert.equal(isOpenFields(fields({ sets: '', rows: [row('5', '80')] })), true);
});
