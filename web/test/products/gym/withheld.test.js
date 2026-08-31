import test from 'node:test';
import assert from 'node:assert/strict';

import {
  heldDetail, heldLine, hiddenIds, openHeld, transientOf, UNDO_LABEL, WINDOW_CLOSED, WITHHELD_KINDS,
  withheldKey,
} from '../../../src/products/gym/withheld.js';

const held = (kind, id, line, at, settling = false, detail = null) => ({
  key: withheldKey(kind, id), kind, id, line, detail, at, settling,
});

test('the window is a list over five verbs, and a key is the verb and the id together', () => {
  assert.deepEqual(WITHHELD_KINDS, ['set', 'routine', 'session', 'thread', 'entry']);
  assert.equal(withheldKey('set', 'set_3'), 'set:set_3');
  assert.equal(withheldKey('routine', 'rt_push'), 'routine:rt_push');
  assert.equal(withheldKey('thread', 'thr_1'), 'thread:thr_1');
  // Two verbs may hold the same id without either standing in for the other.
  assert.notEqual(withheldKey('session', 'x'), withheldKey('entry', 'x'));
});

test('one held delete says WHICH left; several say how many', () => {
  assert.equal(heldLine([]), null);
  assert.equal(heldLine([held('set', 'set_1', '100 × 5 is out of the log.', 1)]), '100 × 5 is out of the log.');
  assert.equal(
    heldLine([held('set', 'set_1', '100 × 5 is out of the log.', 1), held('routine', 'rt_1', 'Push A deleted.', 2)]),
    '2 deleted.',
  );
  assert.equal(heldLine([held('set', 'a', 'x', 1), held('set', 'b', 'y', 2), held('set', 'c', 'z', 3)]), '3 deleted.');
});

test('the count line is the only count line: nothing appends into this window, so nothing is taken back', () => {
  // The phones hold a LOGGED set in the same window, and a count over one says `2 to take back.`
  // there. Web has no such entry — every verb here destroys — so `N deleted.` is honest for every
  // mix of the five, and the other sentence is a state this surface cannot reach.
  const window = WITHHELD_KINDS.map((kind, at) => held(kind, `id_${at}`, `${kind} line`, at));
  assert.equal(heldLine(window), '5 deleted.');
  for (let n = 2; n <= WITHHELD_KINDS.length; n += 1) {
    assert.equal(heldLine(window.slice(0, n)), `${n} deleted.`);
  }
  const everySentence = [heldLine([]), ...window.map((_, at) => heldLine(window.slice(0, at + 1)))];
  assert.deepEqual(everySentence, [
    null, 'set line', '2 deleted.', '3 deleted.', '4 deleted.', '5 deleted.',
  ]);
});

test('the detail is said for one held delete and for no count — Law 4, in the function', () => {
  const thread = held('thread', 'thr_1', 'Conversation deleted.', 1, false, 'a change you applied stays in the routine\u2019s history');
  assert.equal(heldDetail([thread]), 'a change you applied stays in the routine\u2019s history');
  // Past one, the count line takes over and a count has no one detail to carry.
  assert.equal(heldDetail([thread, held('set', 'set_1', '100 \u00d7 5 is out of the log.', 2)]), null);
  assert.equal(heldDetail([]), null);
  // A verb that leaves nothing behind carries nothing.
  assert.equal(heldDetail([held('set', 'set_1', '100 \u00d7 5 is out of the log.', 1)]), null);
});

test('a settling delete is no longer offered back, but its row stays hidden', () => {
  const window = [held('set', 'set_1', 'one', 1, true), held('set', 'set_2', 'two', 2)];
  assert.deepEqual(openHeld(window).map((each) => each.id), ['set_2']);
  // Both ids: a row that reappeared between the clock firing and the store answering would be a
  // deleted row back on screen.
  assert.deepEqual([...hiddenIds(window, [], 'set')], ['set_1', 'set_2']);
  assert.deepEqual([...hiddenIds(window, [], 'routine')], []);
  assert.deepEqual([...hiddenIds([], [], 'set')], []);
});

test('a delete the store has answered for is hidden by the same question, with nothing held', () => {
  const gone = [{ kind: 'routine', id: 'rt_push' }, { kind: 'set', id: 'set_9' }];
  // The window is empty — the clock closed and the entry left it — and the row is still not drawn.
  assert.deepEqual([...hiddenIds([], gone, 'routine')], ['rt_push']);
  assert.deepEqual([...hiddenIds([], gone, 'set')], ['set_9']);
  assert.deepEqual([...hiddenIds([], gone, 'thread')], []);
  // Held and settled under one verb are one answer, and an id in both is asked for once.
  const window = [held('routine', 'rt_pull', 'Pull B deleted.', 3)];
  assert.deepEqual([...hiddenIds(window, gone, 'routine')], ['rt_pull', 'rt_push']);
  assert.deepEqual([...hiddenIds(window, [{ kind: 'routine', id: 'rt_pull' }], 'routine')], ['rt_pull']);
});

test('the transient is whichever spoke last, and the window’s own carries the Undo and no dismiss', () => {
  const said = { text: 'That copy wasn’t made.', at: 5 };
  const window = [held('set', 'set_1', '100 × 5 is out of the log.', 4)];

  // Nothing held: the sentence, exactly as it was said.
  assert.equal(transientOf(said, []), said);
  assert.equal(transientOf(null, []), null);

  // A sentence said AFTER the delete was withheld is read, so a refusal is never hidden behind a
  // window that is still running.
  assert.equal(transientOf(said, window), said);

  // The window spoke last: its line, its Undo, and no `at` older than the newest held.
  const open = transientOf({ text: 'older', at: 2 }, window);
  assert.deepEqual(open, { text: '100 × 5 is out of the log.', detail: null, at: 4, undoable: true });
  assert.equal(transientOf(null, window).undoable, true);

  // Two held, and the newest stamp is the window's.
  // A count carries no detail, even when one of the two held deletes has one of its own.
  const twoWithDetail = [held('thread', 'thr_1', 'Conversation deleted.', 4, false, 'a change you applied stays in the routine\u2019s history'), held('routine', 'rt_1', 'Push A deleted.', 6)];
  assert.deepEqual(transientOf(said, twoWithDetail), { text: '2 deleted.', detail: null, at: 6, undoable: true });

  // One held delete that leaves something behind rides the window with it.
  assert.deepEqual(
    transientOf(null, [held('thread', 'thr_1', 'Conversation deleted.', 8, false, 'a change you applied stays in the routine\u2019s history')]),
    { text: 'Conversation deleted.', detail: 'a change you applied stays in the routine\u2019s history', at: 8, undoable: true },
  );

  // Every entry settling is a window that has closed: the sentence stands and the Undo is gone.
  assert.equal(transientOf(said, [held('set', 'set_1', 'one', 7, true)]), said);
  assert.equal(transientOf(null, [held('set', 'set_1', 'one', 7, true)]), null);
});

test('the two words the window says for itself', () => {
  assert.equal(UNDO_LABEL, 'Undo');
  assert.equal(WINDOW_CLOSED, 'The window closed — that delete already went.');
});
