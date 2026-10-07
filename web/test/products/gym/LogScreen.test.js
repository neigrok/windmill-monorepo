import test from 'node:test';
import assert from 'node:assert/strict';

import { UNDO_MS } from '../../../src/products/gym/fix.js';
import { CLOSED_ITSELF_NOTE } from '../../../src/products/gym/log.js';
import {
  browserWith, confirmed, elementsOf, findByClass, gymAccount, loadScreen, renderHook, roomAndScreen, roomLog, settle,
  textOf,
} from './harness.mjs';

const NOW = Date.UTC(2026, 9, 6, 12);

// One finished session holding one set, as the server confirmed it. Finished on the set's own
// instant, it is a session that closed on its own.
function sessionWithASet({ finishedAt = 1_755_003_600_000 } = {}) {
  return [
    confirmed('session', 'session0001', { startedAt: 1_755_000_000_000, finishedAt }),
    confirmed('set', 'set0000001', { sessionId: 'session0001', exerciseId: 'back-squat', setNumber: 1, weightKg: 100, reps: 5,
      kind: 'working', note: '', completedAt: 1_755_000_600_000 }),
  ];
}

// The screen and the room it lives in, rendered as one: the withheld window belongs to the room, so
// a session screen tested without one is a screen that cannot exist. Both read the account's replica.
async function sessionInARoom(t) {
  const { useTrainingLog } = await loadScreen('products/gym/useTrainingLog.js');
  const { SessionDetail } = await loadScreen('products/gym/Log.jsx');
  const view = renderHook(t, () => {
    const log = useTrainingLog();
    return { log, screen: SessionDetail({ id: 'session0001', log }) };
  }, { live: true });
  await settle();
  return {
    view,
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

test('the log waits for the initial pull before claiming an empty or unmatched history', async (t) => {
  browserWith();
  const { engine } = await gymAccount(t, [confirmed('note', 'note000001', { title: 'Note', body: '', ord: 'a', updatedAt: 0 })]);
  await engine.write(null, (device) => { device.activeReplica.cursors['self/gym'].booted = false; }, ['self/gym']);
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const log = roomLog({ catalog: [{ id: 'chin', name: 'Chin-up' }] });
  const view = renderHook(t, () => ({
    empty: LogList({ log }),
    filtered: LogList({ log, hash: '#/gym/log?year=2024&exercise=chin' }),
    selected: LogList({ log, sessionId: 'sessionMissing' }),
  }), { live: true });
  await settle();
  assert.deepEqual(findByClass(view.tree.empty, 'gym-quiet').map(textOf), []);
  assert.deepEqual(findByClass(view.tree.filtered, 'gym-history-empty').map(textOf), []);
  assert.deepEqual(findByClass(view.tree.selected, 'gym-quiet').map(textOf), []);

  await engine.write(null, (device) => { device.activeReplica.cursors['self/gym'].booted = true; }, ['self/gym']);
  await settle();
  assert.deepEqual(findByClass(view.tree.empty, 'gym-quiet').map(textOf), ['No sessions yet.']);
  assert.deepEqual(findByClass(view.tree.filtered, 'gym-history-empty').map(textOf), ['No Chin-up sessions in 2024.']);
  assert.deepEqual(findByClass(view.tree.selected, 'gym-quiet').map(textOf), [
    'No sessions yet.', 'This workout is outside these filters. Back to results',
  ]);
});

test('the log draws arrived sessions without claiming the initial history has ended', async (t) => {
  browserWith();
  const { engine } = await gymAccount(t, sessionWithASet());
  await engine.write(null, (device) => { device.activeReplica.cursors['self/gym'].booted = false; }, ['self/gym']);
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const view = renderHook(t, () => LogList({ log: roomLog() }), { live: true });
  await settle();
  const rows = () => elementsOf(view.tree).find((each) => typeof each.type === 'function' && each.type.name === 'HistoryIndex').props.sessions;
  assert.deepEqual(rows().map(({ id }) => id), ['session0001']);
  assert.deepEqual(findByClass(view.tree, 'gym-history-end').map(textOf), []);

  await engine.write(null, (device) => { device.activeReplica.cursors['self/gym'].booted = true; }, ['self/gym']);
  await settle();
  assert.deepEqual(rows().map(({ id }) => id), ['session0001']);
  assert.deepEqual(findByClass(view.tree, 'gym-history-end').map(textOf), ['End of history']);
});

test('the cached stored log stance advances when the room reaches a session idle deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  await gymAccount(t, [confirmed('session', 'session_open', { startedAt: NOW - 4 * 3600000 + 1000 })]);
  const { useTrainingLog } = await loadScreen('products/gym/useTrainingLog.js');
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const view = renderHook(t, () => {
    const log = useTrainingLog();
    return { log, screen: LogList({ log }) };
  }, { live: true });
  await settle();
  assert.deepEqual(findByClass(view.tree.screen, 'gym-quiet').map(textOf), ['No sessions yet.']);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(view.tree.log.session, null);
  assert.equal(view.tree.log.summaries[0].closedItself, true);
  assert.deepEqual(findByClass(view.tree.screen, 'gym-quiet').map(textOf), []);
});

test('a held delete goes when its clock runs out, and the transient retires with the window', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, sessionWithASet());
  const room = await sessionInARoom(t);
  assert.deepEqual(gym.owed(), []);

  deleteTheFirstSet(room);
  await settle();
  assert.deepEqual(gym.owed(), ['held delete set set0000001'], 'held on the device at once, and not sent');
  assert.equal(room.transient().text, '100 × 5 is out of the log.');
  assert.equal(room.transient().action.label, 'Undo');
  assert.equal(room.transient().dismiss, null, 'a window retires itself; it is not dismissed');
  assert.equal(findByClass(room.screen(), 'gym-set').length, 0);

  t.mock.timers.tick(UNDO_MS - 1);
  await settle();
  assert.deepEqual(gym.owed(), ['held delete set set0000001']);
  assert.equal(room.transient().action.label, 'Undo');

  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(gym.owed(), ['ready delete set set0000001'], 'released for sending as the window closes');
  assert.equal(room.transient(), null, 'the way back expired, and the transient says so by leaving');
  assert.equal(findByClass(room.screen(), 'gym-set').length, 0);

  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.deepEqual(gym.owed(), ['ready delete set set0000001'], 'one delete, owed once');
});

test('Undo inside the window takes the delete off the device, and the row is back where it was', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, sessionWithASet());
  const room = await sessionInARoom(t);

  deleteTheFirstSet(room);
  await settle();
  assert.equal(findByClass(room.screen(), 'gym-set').length, 0);

  room.transient().action.run();
  await settle();
  assert.equal(findByClass(room.screen(), 'gym-set').length, 1);
  assert.equal(room.transient(), null);
  assert.deepEqual(gym.owed(), []);

  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(gym.owed(), [], 'a delete taken back never happened');
  assert.equal(findByClass(room.screen(), 'gym-set').length, 1);
});

test('a delete the browser cannot keep says the set is still in the log, and puts the row back', async (t) => {
  browserWith();
  const gym = await gymAccount(t, sessionWithASet());
  const room = await sessionInARoom(t);

  gym.refuseWrites();
  deleteTheFirstSet(room);
  await settle();

  assert.equal(
    room.transient().text,
    'That set is still in the log — this device couldn’t store it.',
  );
  assert.equal(room.transient().action, null, 'nothing is left to undo');
  assert.equal(findByClass(room.screen(), 'gym-set').length, 1, 'the set the log kept is drawn again');
  assert.deepEqual(gym.owed(), []);
});

test('the room leaving the screen leaves its held delete to the device, which lets it go at its own deadline, and nothing is offered back', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, sessionWithASet());
  const room = await sessionInARoom(t);

  deleteTheFirstSet(room);
  await settle();
  t.mock.timers.tick(UNDO_MS - 3000);
  // Into another room, three seconds still on the clock. Staying in the app keeps the hold: the
  // delete stays held on the device and its deadline keeps running.
  room.view.unmount();
  await settle();
  assert.deepEqual(gym.owed(), ['held delete set set0000001'], 'nothing was sent');

  // The deadline is the device's, not the room's: the delete is released once, at its own time.
  t.mock.timers.tick(UNDO_MS * 2);
  await settle();
  assert.deepEqual(gym.owed(), ['ready delete set set0000001']);

  // Coming back after the deadline: the set is out of the log, and no way back is offered for a
  // delete whose window has closed.
  const again = await sessionInARoom(t);
  assert.equal(findByClass(again.screen(), 'gym-set').length, 0, 'the row stays off');
  assert.equal(again.transient(), null);
});

test('a set delete settles into a session screen that never armed it, and the row stays gone', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, sessionWithASet());
  const detail = await roomAndScreen(t, {
    module: 'products/gym/Log.jsx',
    render: ({ SessionDetail }, log) => SessionDetail({ id: 'session0001', log }),
  });
  const setsOn = () => findByClass(detail.screen(), 'gym-set').length;

  deleteTheFirstSet(detail);
  await settle();
  detail.redraw();
  assert.equal(setsOn(), 0);

  // Off the session and back, four seconds in: a new screen, reading a store that still has the set.
  t.mock.timers.tick(4000);
  await detail.remount();
  assert.equal(setsOn(), 0, 'still held, and the room is what hides it');

  t.mock.timers.tick(UNDO_MS);
  await settle();
  detail.redraw();
  assert.deepEqual(gym.owed(), ['ready delete set set0000001']);
  assert.equal(setsOn(), 0, 'the delete went, and the row it hid stayed gone');
  assert.equal(detail.log().transient, null);

  await detail.remount();
  assert.equal(setsOn(), 0);
});

// 13-gestures.md: a window decides which rows are drawn; it never decides what state a screen is in.
// Two of this screen's three derived lines are the ACCOUNT's — whether the session holds sets at
// all, and how it ended — while the meta counts the rows under it. The store keeps the set while its
// delete is held, so the stance can only become true once the delete leaves the store.
test('the session’s stance and its closed-on-its-own note read the store, and the meta counts the rows', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  browserWith();
  const gym = await gymAccount(t, sessionWithASet({ finishedAt: 1_755_000_600_000 }));
  const room = await sessionInARoom(t);
  const quiet = () => findByClass(room.screen(), 'gym-quiet').map(textOf);
  const closed = () => findByClass(room.screen(), 'gym-detail-closed').map(textOf);
  const totals = () => textOf(findByClass(room.screen(), 'gym-reader-totals')[0]);

  assert.deepEqual(quiet(), []);
  assert.deepEqual(closed(), [CLOSED_ITSELF_NOTE], 'the session ended on its last set’s instant');
  assert.equal(totals(), 'sets1reps5kg external500');

  deleteTheFirstSet(room);
  await settle();
  assert.equal(findByClass(room.screen(), 'gym-set').length, 0, 'the row is off the screen, which is all the window decides');
  assert.deepEqual(quiet(), [], 'a session holding one set the window has taken off the screen is not an empty session');
  assert.deepEqual(closed(), [CLOSED_ITSELF_NOTE], 'and how it ended is a fact about the log, which no window has changed');
  assert.equal(totals(), 'sets0reps0kg external0', 'the totals count what is drawn under them');

  t.mock.timers.tick(UNDO_MS);
  await settle();
  assert.deepEqual(gym.owed(), ['ready delete set set0000001']);
  assert.deepEqual(quiet(), ['No sets in this session.'], 'the delete left the store, and only now is the session empty');
  assert.deepEqual(closed(), [], 'and the instant the claim was inferred from is gone with it');
});

test('history uses the log’s scope totals and names the unit once, with no legacy session estimate', async (t) => {
  browserWith();
  const workout = (id, startedAt, routineName, sets, reps, weightKg) => [
    confirmed('session', id, { startedAt, finishedAt: startedAt + 3_600_000, displayName: routineName }),
    ...Array.from({ length: sets }, (_, n) => confirmed('set', `${id}set${n}`, { sessionId: id, exerciseId: 'bench-press', setNumber: n + 1,
      weightKg, reps, kind: 'working', note: '', completedAt: startedAt + (n + 1) * 60_000 })),
  ];
  await gymAccount(t, [
    ...workout('sessionSep07', new Date(2026, 8, 7, 18).getTime(), 'Push A', 9, 6, 40),
    ...workout('sessionAug24', new Date(2026, 7, 24, 18).getTime(), 'Bench day', 3, 10, 46),
  ]);
  const summaries = [
    { id: 'ses_2', startedAt: new Date(2026, 8, 7, 18).getTime(), finishedAt: new Date(2026, 8, 7, 19).getTime(), routineName: 'Push A', workingSetCount: 9, tonnageKg: 2160 },
    { id: 'ses_1', startedAt: new Date(2026, 7, 24, 18).getTime(), finishedAt: new Date(2026, 7, 24, 19).getTime(), routineName: 'Bench day', workingSetCount: 3, tonnageKg: 1380 },
  ];
  const { LogList, HistoryIndex } = await loadScreen('products/gym/Log.jsx');
  const view = renderHook(t, () => LogList({ log: roomLog({ summaries }) }));
  await settle();
  assert.deepEqual(findByClass(view.tree, 'gym-log-count').map(textOf), ['2 workouts · 12 sets · 84 reps · loads in kg']);
  const rows = elementsOf(HistoryIndex({ sessions: summaries })).filter((each) => typeof each.type === 'function' && each.type.name === 'SessionRow');
  assert.deepEqual(rows.map((row) => findByClass(row.type(row.props), 'gym-row-facts').map(textOf)), [['9 sets2,160'], ['3 sets1,380']]);
  assert.deepEqual(rows.map((row) => findByClass(row.type(row.props), 'gym-row-when').map(textOf)), [['7 Sep'], ['24 Aug']]);
});


test('empty filtered history names its scope and clears it without drawing unrelated progress', async (t) => {
  browserWith();
  await gymAccount(t);
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const view = renderHook(t, () => LogList({ hash: '#/gym/log?year=2024&exercise=chin', log: roomLog({ catalog: [{ id: 'chin', name: 'Chin-up' }] }) }));
  await settle();
  const empty = findByClass(view.tree, 'gym-history-empty')[0];
  assert.equal(textOf(empty), 'No Chin-up sessions in 2024.');
  assert.equal(findByClass(view.tree, 'gym-history-workspace').length, 0);
  assert.equal(findByClass(view.tree, 'gym-log-footer').length, 0);
  const clear = elementsOf(empty).find((element) => typeof element.type === 'function');
  assert.equal(clear.props.children, 'Clear filters');
  clear.props.onClick();
  assert.equal(window.location.hash, '#/gym/log');
});

test('an index return restores its scoped offset after paging enough history and keeps it across remounts', async (t) => {
  browserWith();
  // A hundred finished workouts: two pages of history.
  await gymAccount(t, Array.from({ length: 100 }, (_, n) => confirmed('session', `session${String(n).padStart(4, '0')}`,
    { startedAt: 1_000_000 + n * 10_000, finishedAt: 1_000_000 + n * 10_000 + 5_000 })));
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const positions = new Map([['#/gym/log', 900]]);
  const pagePositions = new Map([['#/gym/log', 300]]);
  const listeners = new Map();
  const page = { scrollHeight: 1200, clientHeight: 600, scrollTop: 0, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  const rows = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'HistoryIndex').props.sessions.length;
  // The index is as tall as the rows it has drawn, twenty pixels each.
  const indexOf = (view) => ({ get scrollHeight() { return 20 * rows(view.tree); }, clientHeight: 400, scrollTop: 0, closest: (selector) => {
    assert.equal(selector, '.gym-scroll, .gym-root');
    return page;
  } });
  const log = roomLog();
  const first = renderHook(t, () => LogList({ log, positions, pagePositions }));
  const aside = () => findByClass(first.tree, 'gym-history-index')[0];
  const node = indexOf(first);
  aside().ref.current = node;
  // The first page lands short of the offset, and the next is asked for while it is drawn.
  for (let turn = 0; turn < 100 && rows(first.tree) === 0; turn += 1) await Promise.resolve();
  assert.equal(rows(first.tree), 50);
  assert.equal(findByClass(first.tree, 'gym-older')[0].props['aria-busy'], true, 'the missing scroll range fetches the next history page');
  aside().props.onScroll({ currentTarget: { scrollTop: 600 } });
  assert.equal(positions.get('#/gym/log'), 900, 'a temporary clamp while pages load cannot erase the destination');
  await settle();
  assert.equal(rows(first.tree), 100);
  assert.equal(node.scrollTop, 900);
  assert.equal(page.scrollTop, 300);
  page.scrollTop = 450;
  listeners.get('scroll')();
  assert.equal(pagePositions.get('#/gym/log'), 450);
  aside().props.onScroll({ currentTarget: { scrollTop: 1100 } });
  assert.equal(positions.get('#/gym/log'), 1100);
  first.unmount();
  const second = renderHook(t, () => LogList({ log, positions, pagePositions }));
  const nextNode = indexOf(second);
  page.scrollTop = 0;
  findByClass(second.tree, 'gym-history-index')[0].ref.current = nextNode;
  await settle();
  assert.equal(nextNode.scrollTop, 1100);
  assert.equal(page.scrollTop, 450);
});

test('opening a short reader keeps the history page offset for the return', async (t) => {
  browserWith();
  await gymAccount(t, [
    confirmed('session', 'sessionLatest', { startedAt: 3_000_000, finishedAt: 3_600_000 }),
    confirmed('session', 'sessionOldest', { startedAt: 1_000_000, finishedAt: 1_600_000 }),
  ]);
  const { LogList } = await loadScreen('products/gym/Log.jsx');
  const pagePositions = new Map();
  const listeners = new Map();
  const page = { scrollHeight: 1400, clientHeight: 700, scrollTop: 0, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  const node = { scrollHeight: 900, clientHeight: 900, scrollTop: 0, querySelector: () => null, closest: () => page };
  const log = roomLog();
  let sessionId = null;
  const view = renderHook(t, () => LogList({ log, sessionId, pagePositions }));
  findByClass(view.tree, 'gym-history-index')[0].ref.current = node;
  await settle();

  page.scrollTop = 495;
  listeners.get('scroll')();
  assert.deepEqual([...pagePositions], [['#/gym/log', 495]]);

  sessionId = 'sessionOldest';
  page.scrollHeight = 700;
  page.scrollTop = 0;
  view.redraw();
  assert.deepEqual([...pagePositions], [['#/gym/log', 495]]);
  assert.equal(listeners.has('scroll'), false);

  sessionId = null;
  page.scrollHeight = 1400;
  view.redraw();
  assert.equal(page.scrollTop, 495);
  assert.deepEqual([...pagePositions], [['#/gym/log', 495]]);
});
