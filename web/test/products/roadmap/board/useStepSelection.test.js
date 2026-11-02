import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionState } from '../../../../src/products/roadmap/board/useStepSelection.js';

const IDLE = { phase: 'idle', visit: null, ids: [], focus: null };
const visit = { token: 'visit', id: 'dock', column: 'locked', treeId: 'sail', href: 'http://localhost/#/t/sail' };
const cards = { phase: 'cards', visit, ids: ['dock'], focus: 'start' };

test('selection transitions keep the visit, choices and focus intent explicit', () => {
  const started = selectionState(IDLE, { type: 'start', visit });
  assert.deepEqual(started, cards);
  assert.deepEqual(IDLE, { phase: 'idle', visit: null, ids: [], focus: null });
  const focused = selectionState(started, { type: 'focused' });
  assert.deepEqual(focused, { ...cards, focus: null });
  const toggled = selectionState(focused, { type: 'toggle', ids: ['dock', 'triangle'] });
  assert.deepEqual(toggled, { ...cards, ids: ['dock', 'triangle'], focus: null });
  const pruned = selectionState(toggled, { type: 'pruned', ids: ['triangle'] });
  assert.deepEqual(pruned, { ...cards, ids: ['dock'], focus: null });
  const opened = selectionState(pruned, { type: 'openKinds' });
  assert.deepEqual(opened, { ...pruned, phase: 'kinds' });
  const closing = selectionState(opened, { type: 'closeKinds' });
  assert.deepEqual(closing, { ...pruned, phase: 'closingKinds' });
  const returned = selectionState(closing, { type: 'returned', kinds: false });
  assert.deepEqual(returned, pruned);
  assert.deepEqual(returned.ids, ['dock']);
  const chosenAgain = selectionState(returned, { type: 'toggle', ids: ['dock', 'triangle'] });
  assert.deepEqual(chosenAgain, toggled);
});

test('ending while kinds are already popping waits for both history entries before restoring focus', () => {
  const closing = { ...cards, phase: 'closingKinds', focus: null };
  const endingKinds = selectionState(closing, { type: 'end', restore: true });
  assert.deepEqual(endingKinds, { ...cards, phase: 'endingKinds', focus: 'restore' });
  const ending = selectionState(endingKinds, { type: 'leaveKinds' });
  assert.deepEqual(ending, { ...cards, phase: 'ending', focus: 'restore' });
  const left = selectionState(ending, { type: 'left' });
  assert.deepEqual(left, { ...IDLE, visit, focus: 'restore' });
  assert.deepEqual(selectionState(left, { type: 'focused' }), IDLE);
});

test('leaving the Board clears the visit without restoring focus into an inactive view', () => {
  const ending = selectionState(cards, { type: 'end', restore: false });
  assert.deepEqual(ending, { ...cards, phase: 'ending', focus: null });
  assert.deepEqual(selectionState(ending, { type: 'left' }), IDLE);
});

test('restoration intent survives until every selection history entry has left', () => {
  for (const phase of ['ending', 'endingKinds']) {
    const pending = { ...cards, phase, focus: 'restore' };
    assert.deepEqual(selectionState(pending, { type: 'focused' }), pending);
    const left = selectionState(pending, { type: 'left' });
    assert.deepEqual(left, { ...IDLE, visit, focus: 'restore' });
    assert.deepEqual(selectionState(left, { type: 'focused' }), IDLE);
  }
});

test('pending selection exit cannot restart, change choices, reopen kinds or produce another end', () => {
  for (const phase of ['ending', 'endingKinds']) {
    const pending = { ...cards, phase, focus: 'restore' };
    for (const event of [
      { type: 'start', visit }, { type: 'toggle', ids: ['triangle'] },
      { type: 'openKinds' }, { type: 'closeKinds' },
      { type: 'returned', kinds: true }, { type: 'end', restore: true },
    ]) {
      assert.equal(selectionState(pending, event), pending);
    }
    assert.deepEqual(pending, { phase, visit, ids: ['dock'], focus: 'restore' });
  }
});
