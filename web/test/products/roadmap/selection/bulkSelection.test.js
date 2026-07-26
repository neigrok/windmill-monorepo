import test from 'node:test';
import assert from 'node:assert/strict';

import { isGrouped, markDoneTargets } from '../../../../src/products/roadmap/selection/bulkSelection.js';

test('isGrouped — a single selection is not grouped (keeps the loud terracotta look)', () => {
  assert.equal(isGrouped(0), false);
  assert.equal(isGrouped(1), false);
});

test('isGrouped — two or more is grouped (the quiet bark treatment)', () => {
  assert.equal(isGrouped(2), true);
  assert.equal(isGrouped(5), true);
});

test('markDoneTargets — an empty selection completes nothing', () => {
  assert.deepEqual(markDoneTargets(new Set(), new Set()), []);
});

test('markDoneTargets — a set with none complete marks every member', () => {
  assert.deepEqual(
    markDoneTargets(new Set(['a', 'b', 'c']), new Set()),
    ['a', 'b', 'c'],
  );
});

test('markDoneTargets — already-complete members are skipped (no completion replays)', () => {
  assert.deepEqual(
    markDoneTargets(new Set(['a', 'b', 'c']), new Set(['b'])),
    ['a', 'c'],
  );
});

test('markDoneTargets — a fully-complete set marks nothing', () => {
  assert.deepEqual(
    markDoneTargets(new Set(['a', 'b']), new Set(['a', 'b', 'z'])),
    [],
  );
});
