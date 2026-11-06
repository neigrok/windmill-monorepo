import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedCount, selectingAnnouncement } from '../../../../src/products/roadmap/copy.js';
import { selectionState } from '../../../../src/products/roadmap/board/useStepSelection.js';

const IDLE = { phase: 'idle', visit: null, ids: [], last: null, announcement: '', focus: null };
const visit = { token: 'visit', id: 'dock', column: 'locked', treeId: 'sail', href: 'http://localhost/#/t/sail' };
const cards = { phase: 'cards', visit, ids: ['dock'], last: 'dock', announcement: selectingAnnouncement({ count: 1 }), focus: 'start' };

test('selection transitions keep the visit, choices and focus intent explicit', () => {
  const started = selectionState(IDLE, { type: 'start', visit });
  assert.deepEqual(started, cards);
  assert.deepEqual(IDLE, { phase: 'idle', visit: null, ids: [], last: null, announcement: '', focus: null });
  const focused = selectionState(started, { type: 'focused' });
  assert.deepEqual(focused, { ...cards, focus: null });
  const toggled = selectionState(focused, { type: 'toggle', id: 'triangle', ids: ['dock', 'triangle'] });
  assert.deepEqual(toggled, { ...cards, ids: ['dock', 'triangle'], last: 'triangle', announcement: selectedCount({ count: 2 }), focus: null });
  const pruned = selectionState(toggled, { type: 'pruned', ids: ['triangle'] });
  assert.deepEqual(pruned, { ...cards, ids: ['dock'], last: 'triangle', announcement: selectedCount({ count: 1 }), focus: null });
  const opened = selectionState(pruned, { type: 'openKinds' });
  assert.deepEqual(opened, { ...pruned, phase: 'kinds' });
  const closing = selectionState(opened, { type: 'closeKinds' });
  assert.deepEqual(closing, { ...pruned, phase: 'closingKinds' });
  const returned = selectionState(closing, { type: 'returned', kinds: false });
  assert.deepEqual(returned, pruned);
  assert.deepEqual(returned.ids, ['dock']);
  const chosenAgain = selectionState(returned, { type: 'toggle', id: 'triangle', ids: ['dock', 'triangle'] });
  assert.deepEqual(chosenAgain, toggled);
});

test('ending while kinds are already popping waits for both history entries before restoring focus', () => {
  const closing = { ...cards, phase: 'closingKinds', focus: null };
  const endingKinds = selectionState(closing, { type: 'end', restore: true });
  assert.deepEqual(endingKinds, { ...cards, phase: 'endingKinds', announcement: '', focus: 'restore' });
  const ending = selectionState(endingKinds, { type: 'leaveKinds' });
  assert.deepEqual(ending, { ...cards, phase: 'ending', announcement: '', focus: 'restore' });
  const left = selectionState(ending, { type: 'left' });
  assert.deepEqual(left, { ...IDLE, visit, last: 'dock', focus: 'restore' });
  assert.deepEqual(selectionState(left, { type: 'focused' }), IDLE);
});

test('leaving the Board clears the visit without restoring focus into an inactive view', () => {
  const ending = selectionState(cards, { type: 'end', restore: false });
  assert.deepEqual(ending, { ...cards, phase: 'ending', announcement: '', focus: null });
  assert.deepEqual(selectionState(ending, { type: 'left' }), IDLE);
});

test('restoration intent survives until every selection history entry has left', () => {
  for (const phase of ['ending', 'endingKinds']) {
    const pending = { ...cards, phase, focus: 'restore' };
    assert.deepEqual(selectionState(pending, { type: 'focused' }), pending);
    const left = selectionState(pending, { type: 'left' });
    assert.deepEqual(left, { ...IDLE, visit, last: 'dock', focus: 'restore' });
    assert.deepEqual(selectionState(left, { type: 'focused' }), IDLE);
  }
});

test('pending selection exit cannot restart, change choices, reopen kinds or produce another end', () => {
  for (const phase of ['ending', 'endingKinds']) {
    const pending = { ...cards, phase, focus: 'restore' };
    for (const event of [
      { type: 'start', visit }, { type: 'toggle', id: 'triangle', ids: ['triangle'] },
      { type: 'openKinds' }, { type: 'closeKinds' },
      { type: 'returned', kinds: true }, { type: 'end', restore: true },
    ]) {
      assert.equal(selectionState(pending, event), pending);
    }
    assert.deepEqual(pending, { ...cards, phase, focus: 'restore' });
  }
});


test('announcement starts once, counts up and down to one, then clears while the last toggled card survives every restoring end', () => {
  const started = selectionState(IDLE, { type: 'start', visit });
  assert.deepEqual(started, cards);
  const two = selectionState(started, { type: 'toggle', id: 'triangle', ids: ['dock', 'triangle'] });
  assert.deepEqual(two, { ...cards, ids: ['dock', 'triangle'], last: 'triangle', announcement: selectedCount({ count: 2 }) });
  const one = selectionState(two, { type: 'toggle', id: 'triangle', ids: ['dock'] });
  assert.deepEqual(one, { ...cards, last: 'triangle', announcement: selectedCount({ count: 1 }) });
  const pruned = selectionState(two, { type: 'pruned', ids: ['triangle'] });
  assert.deepEqual(pruned, one);
  for (const beforeEnd of [one, selectionState(one, { type: 'toggle', id: 'dock', ids: [] })]) {
    const ended = selectionState(beforeEnd, { type: 'end', restore: true });
    assert.deepEqual(ended, { ...beforeEnd, phase: 'ending', announcement: '', focus: 'restore' });
    const left = selectionState(ended, { type: 'left' });
    assert.deepEqual(left, { ...IDLE, visit, last: beforeEnd.last, focus: 'restore' });
    assert.deepEqual(selectionState(left, { type: 'focused' }), IDLE);
  }
});
