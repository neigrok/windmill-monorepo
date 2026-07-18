import test from 'node:test';
import assert from 'node:assert/strict';

import { deleteCostLine, progressVerb } from '../../../../src/skilltree/ui/mobile/editorSheet.js';

test('deleteCostLine — a leaf states only the removal, no branches resplice', () => {
  assert.equal(deleteCostLine(0), 'Removes this step');
  assert.equal(deleteCostLine(-1), 'Removes this step');
});

test('deleteCostLine — one child reads in the singular', () => {
  assert.equal(deleteCostLine(1), 'Removes this step · 1 branch resplices');
});

test('deleteCostLine — many children read in the plural', () => {
  assert.equal(deleteCostLine(2), 'Removes this step · 2 branches resplice');
  assert.equal(deleteCostLine(7), 'Removes this step · 7 branches resplice');
});

test('progressVerb — an unlocked, not-yet-done step marks complete', () => {
  assert.equal(progressVerb('available'), 'complete');
  assert.equal(progressVerb('active'), 'complete');
});

test('progressVerb — a completed step offers the reversal (no chip menu on touch)', () => {
  assert.equal(progressVerb('complete'), 'uncomplete');
});

test('progressVerb — a locked step offers no progress toggle', () => {
  assert.equal(progressVerb('locked'), null);
});
