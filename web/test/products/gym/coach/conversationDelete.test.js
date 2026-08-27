// Deleting a conversation, proved at the two screens that draw it. A conversation lives only on the
// store, so this delete is the one the withheld window exists for: an Undo offered over a DELETE
// already sent would be a lie, and every case here watches the wire to say it never is.

import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../../src/shell/apiBase.js';
import { UNDO_MS } from '../../../../src/products/gym/fix.js';
import { THREADS_HREF } from '../../../../src/products/gym/log.js';
import { THREAD_ABSENT, THREAD_DELETED } from '../../../../src/products/gym/coach/threads.js';
import {
  browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, settle, textOf,
} from '../harness.mjs';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

const thread = (id, title, askedAt) => ({
  id,
  title,
  createdAt: askedAt,
  askedAt,
  outcome: { kind: 'read-only', changes: 0 },
  proposals: [],
  turns: [{ from: 'lifter', text: title, at: askedAt }],
});

// Newest first, as the wire sends them.
const STORED = [
  thread('thr_3', 'Heavier bench?', 1_755_300_000_000),
  thread('thr_2', 'Deload week?', 1_755_200_000_000),
  thread('thr_1', 'More rows?', 1_755_100_000_000),
];

// The store, and everything the screens asked it. The room's own boot goes through the injected api,
// so every line here was asked for by a screen. `deleted` is the store's memory: a re-read after a
// delete answers the truth, which is the only way a stale list can be caught.
function threadsOnTheWire({ deleteStatus = 204 } = {}) {
  const wire = [];
  const deleted = new Set();
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    const method = options.method ?? 'GET';
    wire.push(`${method} ${path}`);
    if (path === '/threads') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ threads: STORED.filter((each) => !deleted.has(each.id)) }),
      };
    }
    const one = STORED.find((each) => path === `/threads/${each.id}`);
    if (one && method === 'GET') {
      if (deleted.has(one.id)) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
      return { ok: true, status: 200, json: async () => one };
    }
    if (one && method === 'DELETE') {
      if (deleteStatus < 300) deleted.add(one.id);
      return { ok: deleteStatus < 300, status: deleteStatus, json: async () => ({ error: 'internal error' }) };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return wire;
}

const quietApi = { exercises: async () => [], sessions: async () => [], preferences: async () => ({}) };

// The room, with both of Coach's screens inside it. Both are drawn every render because the harness
// reads hooks by position, so a screen that came and went would be read as the other's — and because
// what is under test is the ROOM's window, which every screen draws around and none of them owns.
// `open` is the conversation the detail is on, the way the hash would be.
async function coachRoom(t, open) {
  const { useTrainingLog } = await loadScreen('products/gym/useTrainingLog.js');
  const { ThreadsList, ThreadDetail } = await loadScreen('products/gym/coach/Threads.jsx');
  const looking = { at: open };
  const view = renderHook(t, () => {
    const log = useTrainingLog({ api: quietApi });
    return { log, detail: ThreadDetail({ id: looking.at, log }), list: ThreadsList({ log }) };
  });
  await settle();
  return {
    view,
    log: () => view.tree.log,
    detail: () => view.tree.detail,
    list: () => view.tree.list,
    // Walking to another conversation, and then to the list.
    walkTo: async (id) => { looking.at = id; view.redraw(); await settle(); },
    // Everything still withheld goes, so the mocked clock is not left holding a timer.
    drain: async () => { t.mock.timers.tick(UNDO_MS * 2); await settle(); },
  };
}

// A row and the delete block are each their own component, so the tree holds them as elements: a
// row's props are what the list handed it, and the block is drawn by calling it.
const componentIn = (tree, name) => elementsOf(tree)
  .filter((each) => typeof each.type === 'function' && each.type.name === name);

const titles = (tree) => componentIn(tree, 'ThreadRow').map((each) => each.props.thread.title);

const deleteVerb = (tree) => {
  const block = componentIn(tree, 'DeleteThread')[0];
  if (!block) return undefined;
  return findByClass(block.type(block.props), 'gym-thread-delete-verb')[0];
};

const deletes = (wire) => wire.filter((line) => line.startsWith('DELETE'));

test('deleting a conversation is one press: no arm, no confirmation, and nothing on the wire', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = threadsOnTheWire();
  const room = await coachRoom(t, 'thr_2');

  // One press and one label: the second tap the old delete asked for is gone, and with it the
  // sentence that promised no way back.
  const verb = deleteVerb(room.detail());
  assert.equal(textOf(verb), 'Delete this conversation');
  verb.props.onClick();
  await settle();

  assert.deepEqual(deletes(wire), [], 'withheld means NOT SENT');
  assert.equal(room.log().transient.text, THREAD_DELETED);
  assert.equal(room.log().transient.text, 'Conversation deleted.');
  assert.equal(room.log().transient.action.label, 'Undo');
  assert.equal(room.log().transient.dismiss, null, 'a way back that could be dismissed early is no way back');
  assert.equal(window.location.hash, THREADS_HREF, 'the lifter is put back on the list, and the transient comes too');
  await room.drain();
});

test('the row is off the list at once, and the window runs the full nine seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = threadsOnTheWire();
  const room = await coachRoom(t, 'thr_2');
  deleteVerb(room.detail()).props.onClick();
  await settle();

  assert.deepEqual(titles(room.list()), ['Heavier bench?', 'More rows?'], 'the row left the list at once');
  assert.equal(textOf(findByClass(room.list(), 'gym-threads-count')[0]), '2 conversations · yours to delete');

  t.mock.timers.tick(UNDO_MS - 1);
  await settle();
  assert.deepEqual(deletes(wire), [], 'not one millisecond early');

  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(deletes(wire), ['DELETE /threads/thr_2'], 'exactly one, nine seconds later');
  assert.equal(room.log().transient, null, 'the transient retires with the last clock');
  // The list read again once the store had answered, so the row cannot come back off the read it
  // took while the conversation was still there.
  assert.deepEqual(titles(room.list()), ['Heavier bench?', 'More rows?']);
});

test('Undo puts the conversation back at its own position, and the delete is never sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = threadsOnTheWire();
  const room = await coachRoom(t, 'thr_2');
  deleteVerb(room.detail()).props.onClick();
  await settle();
  assert.deepEqual(titles(room.list()), ['Heavier bench?', 'More rows?']);

  room.log().transient.action.run();
  await settle();
  // Its own position — the middle of the three, not the top of the list and not the end of it.
  assert.deepEqual(titles(room.list()), ['Heavier bench?', 'Deload week?', 'More rows?']);
  assert.equal(room.log().transient, null);

  await room.drain();
  assert.deepEqual(deletes(wire), [], 'a delete taken back never happened');
  assert.equal(wire.filter((line) => line === 'GET /threads').length, 1, 'and the list was not re-read for it');
});

test('two conversations deleted in one second are held together, and both come back newest first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = threadsOnTheWire();
  const room = await coachRoom(t, 'thr_3');
  deleteVerb(room.detail()).props.onClick();
  await room.walkTo('thr_1');
  t.mock.timers.tick(400);
  deleteVerb(room.detail()).props.onClick();
  await settle();

  assert.equal(room.log().transient.text, '2 deleted.');
  assert.deepEqual(titles(room.list()), ['Deload week?'], 'both rows are off the list');
  assert.deepEqual(deletes(wire), []);

  room.log().transient.action.run();
  await settle();
  assert.deepEqual(titles(room.list()), ['Deload week?', 'More rows?'], 'the newest delete comes back first');
  assert.equal(room.log().transient.text, THREAD_DELETED, 'and the transient re-reads for the one still held');

  room.log().transient.action.run();
  await settle();
  assert.deepEqual(titles(room.list()), ['Heavier bench?', 'Deload week?', 'More rows?']);
  assert.equal(room.log().transient, null);

  await room.drain();
  assert.deepEqual(deletes(wire), []);
});

test('two windows left to run send two deletes, each on its own clock', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = threadsOnTheWire();
  const room = await coachRoom(t, 'thr_3');
  deleteVerb(room.detail()).props.onClick();
  await room.walkTo('thr_1');
  t.mock.timers.tick(400);
  deleteVerb(room.detail()).props.onClick();
  await settle();

  // The second delete did not shorten the first's clock, and the first did not lengthen the second's.
  t.mock.timers.tick(UNDO_MS - 400);
  await settle();
  assert.deepEqual(deletes(wire), ['DELETE /threads/thr_3']);
  assert.equal(room.log().transient.text, THREAD_DELETED, 'the second window is still open behind it');

  t.mock.timers.tick(400);
  await settle();
  assert.deepEqual(deletes(wire), ['DELETE /threads/thr_3', 'DELETE /threads/thr_1']);
  assert.equal(room.log().transient, null);
  assert.deepEqual(titles(room.list()), ['Deload week?']);
});

test('the window follows the lifter off the screen that opened it, and the room leaving abandons it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = threadsOnTheWire();
  const room = await coachRoom(t, 'thr_2');
  deleteVerb(room.detail()).props.onClick();

  // Off that conversation and onto another: the window is the room's, not the screen's, and walking
  // away settles nothing.
  await room.walkTo('thr_3');
  t.mock.timers.tick(UNDO_MS - 1);
  await settle();
  assert.equal(room.log().held.length, 1);
  assert.equal(room.log().transient.text, THREAD_DELETED);
  assert.deepEqual(deletes(wire), []);
  assert.equal(textOf(findByClass(room.detail(), 'gym-thread-name')[0]), 'Heavier bench?');

  // The room itself going ABANDONS what it was holding: nothing is sent, so the conversation is
  // still there on the next open, and nothing is said about it, because nothing happened.
  room.view.unmount();
  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(deletes(wire), []);

  const again = await coachRoom(t, 'thr_2');
  assert.deepEqual(titles(again.list()), ['Heavier bench?', 'Deload week?', 'More rows?']);
  assert.equal(textOf(findByClass(again.detail(), 'gym-thread-name')[0]), 'Deload week?');
  assert.equal(again.log().transient, null);
});

test('a conversation the window is holding is not walked back into', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  threadsOnTheWire();
  const room = await coachRoom(t, 'thr_2');
  deleteVerb(room.detail()).props.onClick();
  await settle();

  // A back gesture may not open a room the room says is deleted, however readable the store still
  // finds it.
  assert.equal(findByClass(room.detail(), 'gym-thread-name').length, 0);
  assert.equal(deleteVerb(room.detail()), undefined);
  assert.equal(textOf(findByClass(room.detail(), 'gym-quiet')[0]), THREAD_ABSENT);
  assert.equal(THREAD_ABSENT, 'That conversation isn’t here any more.');

  // Taken back, it is a conversation again.
  room.log().transient.action.run();
  await settle();
  assert.equal(textOf(findByClass(room.detail(), 'gym-thread-name')[0]), 'Deload week?');
  await room.drain();
});

test('a conversation still open when its own window closes says it is gone, and does not draw again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  threadsOnTheWire();
  const room = await coachRoom(t, 'thr_2');
  deleteVerb(room.detail()).props.onClick();
  await room.drain();

  // The clock fired under a screen still on that conversation: the read it holds is a conversation
  // the store no longer has, so the screen reads again rather than drawing it back.
  assert.equal(findByClass(room.detail(), 'gym-thread-name').length, 0);
  assert.equal(textOf(findByClass(room.detail(), 'gym-quiet')[0]), THREAD_ABSENT);
});

test('a delete the store refuses says the conversation is still here, and the row is back on the list', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const wire = threadsOnTheWire({ deleteStatus: 500 });
  const room = await coachRoom(t, 'thr_2');
  deleteVerb(room.detail()).props.onClick();
  await settle();

  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.deepEqual(deletes(wire), ['DELETE /threads/thr_2']);
  assert.equal(
    room.log().transient.text,
    'That conversation is still here — the log didn’t answer. Try again when you have signal.',
  );
  assert.equal(room.log().transient.action, null, 'a refusal offers no Undo: there is nothing left to take back');
  assert.deepEqual(titles(room.list()), ['Heavier bench?', 'Deload week?', 'More rows?']);
});

test('the list draws around what the window holds, settling included', async (t) => {
  browserWith();
  threadsOnTheWire();
  const { ThreadsList } = await loadScreen('products/gym/coach/Threads.jsx');
  const held = { key: 'thread:thr_2', kind: 'thread', id: 'thr_2', line: THREAD_DELETED, at: 1, settling: false };
  const draw = async (log) => {
    const view = renderHook(t, () => ThreadsList({ log }));
    await settle();
    return view.tree;
  };

  assert.deepEqual(titles(await draw(roomLog({ held: [held] }))), ['Heavier bench?', 'More rows?']);
  // Settling — the send is in the air — and the row is still hidden, because a row flashing back
  // between the clock and the store's answer would be a deleted conversation on screen.
  assert.deepEqual(
    titles(await draw(roomLog({ held: [{ ...held, settling: true }] }))),
    ['Heavier bench?', 'More rows?'],
  );
  assert.deepEqual(titles(await draw(roomLog())), ['Heavier bench?', 'Deload week?', 'More rows?']);
});
