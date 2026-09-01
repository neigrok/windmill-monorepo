import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../src/shell/apiBase.js';
import { UNDO_MS } from '../../../src/products/gym/fix.js';
import { CLOSED_ITSELF_NOTE, sessionDetailMeta } from '../../../src/products/gym/log.js';
import {
  browserWith, elementsOf, findByClass, loadScreen, renderHook, roomAndScreen, settle, textOf,
} from './harness.mjs';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

// `deleted` is the store's memory: a session read again after the window closes answers the truth,
// which is the only way a screen drawn around a stale read can be caught.
function sessionOnTheWire({ deleteStatus = 204 } = {}) {
  const wire = [];
  let deleted = false;
  const session = { id: 'ses_1', startedAt: 1_755_000_000_000, finishedAt: 1_755_003_600_000 };
  const set = { id: 'set_1', exerciseId: 'back-squat', setNumber: 1, weightKg: 100, reps: 5, kind: 'working', completedAt: 1_755_000_600_000 };
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    wire.push(`${options.method ?? 'GET'} ${path}`);
    if (path === '/exercises') return { ok: true, status: 200, json: async () => ({ exercises: [{ id: 'back-squat', name: 'Back Squat' }] }) };
    if (path === '/sessions/ses_1') {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ session, sets: deleted ? [] : [set] }) };
    }
    if (path === '/sessions/ses_1/sets/set_1' && options.method === 'DELETE') {
      if (deleteStatus < 300) deleted = true;
      return { ok: deleteStatus < 300, status: deleteStatus, json: async () => ({ error: 'internal error' }) };
    }
    throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
  };
  return { wire, set };
}

// The screen and the room it lives in, rendered as one: the withheld window belongs to the room, so
// a session screen tested without one is a screen that cannot exist. The room's own reads go through
// the injected api; everything the screen does goes through `fetch`.
async function sessionInARoom(t, { api = null } = {}) {
  const { useTrainingLog } = await loadScreen('products/gym/useTrainingLog.js');
  const { SessionDetail } = await loadScreen('products/gym/Log.jsx');
  const reads = [];
  const room = api ?? {
    exercises: async () => [],
    sessions: async () => { reads.push('GET /sessions'); return []; },
    preferences: async () => ({}),
  };
  const view = renderHook(t, () => {
    const log = useTrainingLog({ api: room });
    return { log, screen: SessionDetail({ id: 'ses_1', log }) };
  });
  await settle();
  return {
    view,
    reads,
    log: () => view.tree.log,
    screen: () => view.tree.screen,
    transient: () => view.tree.log.transient,
  };
}

const deleteTheFirstSet = (room) => {
  const row = findByClass(room.screen(), 'gym-set')[0];
  assert.notEqual(row, undefined, 'the set row is the door onto the fix');
  row.props.onClick();
  const sheet = elementsOf(room.screen()).find((each) => typeof each.type === 'function' && each.type.name === 'FixSheet');
  assert.notEqual(sheet, undefined);
  sheet.props.onDelete();
};

test('a withheld delete goes when its clock runs out, and the transient retires with the window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const { wire, set } = sessionOnTheWire();
  const room = await sessionInARoom(t);
  assert.deepEqual(wire, ['GET /sessions/ses_1', 'GET /exercises']);

  deleteTheFirstSet(room);
  assert.deepEqual(wire, ['GET /sessions/ses_1', 'GET /exercises'], 'nothing is on the wire yet');
  assert.equal(room.transient().text, '100 × 5 is out of the log.');
  assert.equal(room.transient().action.label, 'Undo');
  assert.equal(room.transient().dismiss, null, 'a window retires itself; it is not dismissed');
  assert.equal(findByClass(room.screen(), 'gym-set').length, 0);

  t.mock.timers.tick(UNDO_MS - 1);
  assert.deepEqual(wire, ['GET /sessions/ses_1', 'GET /exercises']);
  assert.equal(room.transient().action.label, 'Undo');

  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(wire, ['GET /sessions/ses_1', 'GET /exercises', 'DELETE /sessions/ses_1/sets/set_1']);
  assert.equal(room.transient(), null, 'the way back expired, and the transient says so by leaving');
  assert.equal(findByClass(room.screen(), 'gym-set').length, 0);

  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.equal(wire.filter((line) => line.startsWith('DELETE')).length, 1);
  assert.equal(set.id, 'set_1');
});

test('Undo inside the window sends nothing at all, and the row is back where it was', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const { wire } = sessionOnTheWire();
  const room = await sessionInARoom(t);

  deleteTheFirstSet(room);
  assert.equal(findByClass(room.screen(), 'gym-set').length, 0);

  room.transient().action.run();
  assert.equal(findByClass(room.screen(), 'gym-set').length, 1);
  assert.equal(room.transient(), null);

  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(wire, ['GET /sessions/ses_1', 'GET /exercises'], 'a delete taken back never happened');
});

test('a delete refused when the window closes says the set is still in the log, and puts the row back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const { wire } = sessionOnTheWire({ deleteStatus: 500 });
  const room = await sessionInARoom(t);

  deleteTheFirstSet(room);
  t.mock.timers.tick(UNDO_MS);
  await settle();

  assert.deepEqual(wire.slice(2), ['DELETE /sessions/ses_1/sets/set_1']);
  assert.equal(
    room.transient().text,
    'That set is still in the log — the log didn’t answer. Try again when you have signal.',
  );
  assert.equal(room.transient().action, null, 'nothing is left to undo');
  assert.equal(findByClass(room.screen(), 'gym-set').length, 1, 'the set the store kept is drawn again');
});

test('the room leaving the screen abandons every delete it is still holding', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const { wire } = sessionOnTheWire();
  const room = await sessionInARoom(t);

  deleteTheFirstSet(room);
  t.mock.timers.tick(UNDO_MS - 3000);
  // Out of the gym entirely, three seconds still on the clock. A send here would be a delete the
  // lifter can no longer take back, reached by two ordinary acts — the hazard the window exists for.
  room.view.unmount();
  await settle();
  assert.deepEqual(wire, ['GET /sessions/ses_1', 'GET /exercises'], 'nothing went on the wire');

  // And the clock does not outlive the room that armed it.
  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(wire, ['GET /sessions/ses_1', 'GET /exercises'], 'the clock died with the room');

  // Coming back: the set the store still holds is drawn, and nothing is said, because nothing
  // happened. The lifter can simply delete it again.
  const again = await sessionInARoom(t);
  assert.equal(findByClass(again.screen(), 'gym-set').length, 1, 'the row is back');
  assert.equal(again.transient(), null);
});

test('a set delete settles into a session screen that never armed it, and the row stays gone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const { wire } = sessionOnTheWire();
  const reads = [];
  const detail = await roomAndScreen(t, {
    module: 'products/gym/Log.jsx',
    render: ({ SessionDetail }, log) => SessionDetail({ id: 'ses_1', log }),
    api: {
      exercises: async () => [],
      sessions: async () => { reads.push('GET /sessions'); return []; },
      preferences: async () => ({}),
    },
  });
  const setsOn = () => findByClass(detail.screen(), 'gym-set').length;

  deleteTheFirstSet(detail);
  detail.redraw();
  assert.equal(setsOn(), 0);

  // Off the session and back, four seconds in: a new screen, reading a store that still has the set.
  t.mock.timers.tick(4000);
  await detail.remount();
  assert.equal(wire.filter((line) => line === 'GET /sessions/ses_1').length, 2, 'the second screen read it again');
  assert.equal(setsOn(), 0, 'still held, and the room is what is holding it');

  t.mock.timers.tick(UNDO_MS);
  await settle();
  detail.redraw();
  assert.equal(wire.filter((line) => line.startsWith('DELETE')).length, 1);
  assert.equal(setsOn(), 0, 'the delete landed, and the row it hid stayed gone');
  assert.equal(detail.log().transient, null);

  await detail.remount();
  assert.equal(setsOn(), 0);
});

// 13-gestures.md: a window decides which rows are drawn; it never decides what state a screen is in.
// Two of this screen's three derived lines are the ACCOUNT's — whether the session holds sets at
// all, and how it ended — while the meta counts the rows under it. The store here never stops
// serving the set: this screen's own read is taken once and the delete's send re-reads the log's
// page, not this session, so the stance can only become true because the settled delete leaves the
// room's own read of what the account holds.
function closedItselfOnTheWire() {
  const wire = [];
  const session = { id: 'ses_1', startedAt: 1_755_000_000_000, finishedAt: 1_755_000_600_000 };
  const set = { id: 'set_1', exerciseId: 'back-squat', setNumber: 1, weightKg: 100, reps: 5, kind: 'working', completedAt: 1_755_000_600_000 };
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    wire.push(`${options.method ?? 'GET'} ${path}`);
    if (path === '/exercises') return { ok: true, status: 200, json: async () => ({ exercises: [{ id: 'back-squat', name: 'Back Squat' }] }) };
    if (path === '/sessions/ses_1/sets/set_1' && options.method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) };
    if (path === '/sessions/ses_1') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ session, sets: [set] }) };
    throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
  };
  return { wire, session, set };
}

test('the session’s stance and its closed-on-its-own note read the store, and the meta counts the rows', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const { wire, session, set } = closedItselfOnTheWire();
  const room = await sessionInARoom(t);
  const quiet = () => findByClass(room.screen(), 'gym-quiet').map(textOf);
  const closed = () => findByClass(room.screen(), 'gym-detail-closed').map(textOf);
  const meta = () => textOf(findByClass(room.screen(), 'gym-detail-when')[0]);

  assert.deepEqual(quiet(), []);
  assert.deepEqual(closed(), [CLOSED_ITSELF_NOTE], 'the session ended on its last set’s instant');
  assert.equal(meta(), sessionDetailMeta(session, [set]));

  deleteTheFirstSet(room);
  assert.equal(findByClass(room.screen(), 'gym-set').length, 0, 'the row is off the screen, which is all the window decides');
  assert.deepEqual(quiet(), [], 'a session holding one set the window has taken off the screen is not an empty session');
  assert.deepEqual(closed(), [CLOSED_ITSELF_NOTE], 'and how it ended is a fact about the log, which no window has changed');
  assert.equal(meta(), sessionDetailMeta(session, []), 'the meta counts what is drawn under it');
  assert.notEqual(sessionDetailMeta(session, []), sessionDetailMeta(session, [set]));

  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.equal(wire.filter((line) => line.startsWith('DELETE')).length, 1);
  assert.equal(wire.filter((line) => line === 'GET /sessions/ses_1').length, 1, 'this screen never read the session again');
  assert.deepEqual(quiet(), ['No sets in this session.'], 'the store answered, and only now is the session empty');
  assert.deepEqual(closed(), [], 'and the instant the claim was inferred from is gone with it');
});

test('the log that did not open names its reason, and offers the repair for it', async () => {
  const { LogNotOpen } = await loadScreen('products/gym/Log.jsx');
  const pressed = [];
  const log = (failure) => ({ phase: 'failed', failure, retryBoot: () => pressed.push('retry') });
  const onSignIn = () => pressed.push('sign-in');
  // The repair is the design system's Button now, so it is a component element and not a class.
  const repair = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function');

  const signedOut = LogNotOpen({ log: log('signed-out'), onSignIn });
  assert.equal(textOf(signedOut), 'Your sign-in lapsed.');
  assert.equal(repair(signedOut).props.children, 'Sign in');
  repair(signedOut).props.onClick();
  assert.deepEqual(pressed, ['sign-in']);

  const server = LogNotOpen({ log: log('server'), onSignIn });
  assert.equal(textOf(server), 'The log didn’t answer.');
  assert.equal(/signal/.test(textOf(server)), false);
  assert.equal(repair(server).props.children, 'Retry');
  repair(server).props.onClick();
  assert.deepEqual(pressed, ['sign-in', 'retry']);

  const signal = LogNotOpen({ log: log('signal'), onSignIn });
  assert.equal(textOf(signal), 'The log didn’t load. Open it again when you have signal.');
  repair(signal).props.onClick();
  assert.deepEqual(pressed, ['sign-in', 'retry', 'retry']);
});
