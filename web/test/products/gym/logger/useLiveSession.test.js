// The live session, driven for real. This is the one file in gym where the pure rules meet the
// network, the clock and the browser's storage, and the four things pinned here are the four ways
// a lifter's set has actually been lost or falsified:
//   · the queue goes out BEFORE the boot read, because the read is what auto-closes the session;
//   · a late `last time` never moves a number the lifter has already dialled;
//   · every set still in the queue draws as saved on this device, attempted or not;
//   · nothing can be logged into a session that is closing, and pocketing the phone does not
//     spend the undo window.
// And one read that loses history rather than sets: the walk down the log pages on the PAIR
// (startedAt, id), because an instant-only cursor leaves a tied session in no page, ever.
// And one door that decides what a reload is allowed to believe: the resume blob typechecks or it
// is discarded out loud — and because that blob holds no sets, a discard can never be one.
//
// React is driven through its own dispatcher rather than a DOM: the hook is the unit under test,
// effects run where React runs them, and every state change re-renders synchronously.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { GymError } from '../../../../src/products/gym/gymApi.js';

const { ReactCurrentDispatcher } = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
const HOUR = 3600_000;

// Teardown is registered with the runner at mount, never trailed at the end of a test body: a
// thrown assertion skips the rest of the body, and the hook's intervals would then hold the event
// loop open — the runner hangs forever instead of reporting the failure.
function renderHook(t, run) {
  const cells = [];
  const queued = [];
  let cursor = 0;
  let rendering = false;
  let result = null;

  const same = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((each, index) => Object.is(each, right[index]));

  const dispatcher = {
    useState(initial) {
      const cell = cells[cursor] ?? (cells[cursor] = { value: typeof initial === 'function' ? initial() : initial });
      cursor += 1;
      return [cell.value, (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next;
        if (Object.is(value, cell.value)) return;
        cell.value = value;
        if (!rendering) render();
      }];
    },
    useRef(initial) {
      const cell = cells[cursor] ?? (cells[cursor] = { current: initial });
      cursor += 1;
      return cell;
    },
    useMemo(factory, deps) {
      const cell = cells[cursor] ?? (cells[cursor] = {});
      cursor += 1;
      if (!('value' in cell) || !same(cell.deps, deps)) {
        cell.value = factory();
        cell.deps = deps;
      }
      return cell.value;
    },
    useCallback(fn, deps) { return dispatcher.useMemo(() => fn, deps); },
    useEffect(effect, deps) {
      const cell = cells[cursor] ?? (cells[cursor] = {});
      cursor += 1;
      if ('deps' in cell && same(cell.deps, deps)) return;
      cell.deps = deps;
      queued.push(cell, effect);
    },
    useLayoutEffect(effect, deps) { dispatcher.useEffect(effect, deps); },
    useDebugValue() {},
  };

  function render() {
    rendering = true;
    cursor = 0;
    const outer = ReactCurrentDispatcher.current;
    ReactCurrentDispatcher.current = dispatcher;
    try {
      result = run();
    } finally {
      ReactCurrentDispatcher.current = outer;
      rendering = false;
    }
    while (queued.length > 0) {
      const cell = queued.shift();
      const effect = queued.shift();
      cell.cleanup?.();
      cell.cleanup = effect() ?? null;
    }
  }

  render();
  t.after(() => cells.forEach((cell) => cell.cleanup?.()));
  return {
    get live() { return result; },
  };
}

const settle = async (turns = 4) => {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

// `live` is seeded as RAW BYTES, never as an object to be stringified: half of what the resume door
// has to survive is a blob that is not JSON at all, and a fake that could only express well-formed
// values would be unable to ask the question.
function browserWith({ queue = [], live = null } = {}) {
  const disk = new Map();
  if (queue.length > 0) disk.set('windmill.gym.queue', JSON.stringify(queue));
  if (live !== null) disk.set('windmill.gym.live', live);
  const listeners = new Map();
  const bind = (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  const unbind = (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((each) => each !== fn));
  globalThis.window = {
    localStorage: {
      getItem: (key) => (disk.has(key) ? disk.get(key) : null),
      setItem: (key, value) => disk.set(key, value),
      removeItem: (key) => disk.delete(key),
    },
    addEventListener: bind,
    removeEventListener: unbind,
    location: { hash: '#/gym' },
  };
  globalThis.document = { visibilityState: 'visible', addEventListener: bind, removeEventListener: unbind };
  globalThis.navigator = { onLine: true };
  return {
    held: () => JSON.parse(disk.get('windmill.gym.queue') ?? '[]'),
    kept: () => disk.get('windmill.gym.live') ?? null,
    hide: () => {
      globalThis.document.visibilityState = 'hidden';
      (listeners.get('visibilitychange') ?? []).forEach((fn) => fn());
    },
  };
}

// The shipped backend's two load-bearing behaviours: reading the log SETTLES an open session idle
// four hours, and a new set into a session that has closed is refused terminally.
function logThatSettles({ startedAt, lastActivityAt, sets = [] }) {
  const wire = [];
  const session = { id: 'ses_probe', startedAt, finishedAt: null };
  const stored = [...sets];
  return {
    wire,
    session,
    stored,
    api: {
      async exercises() {
        wire.push('GET /exercises');
        return [{ id: 'back-squat', name: 'Back Squat' }, { id: 'bench-press', name: 'Bench Press' }];
      },
      async sessions() {
        wire.push('GET /sessions');
        if (!session.finishedAt && Date.now() - lastActivityAt >= 4 * HOUR) session.finishedAt = lastActivityAt;
        return [{ ...session, setCount: stored.length, exercises: [] }];
      },
      async session(id) {
        wire.push(`GET /sessions/${id}`);
        return { session: { ...session }, sets: stored.slice() };
      },
      async appendSet(sessionId, body) {
        wire.push(`POST sets ${body.id}`);
        if (session.finishedAt) throw new GymError(409, 'that session is finished', 'session-finished');
        stored.push({ ...body, setNumber: stored.length + 1 });
        lastActivityAt = body.completedAt;
        return stored[stored.length - 1];
      },
      async finishSession(id, { finishedAt }) {
        wire.push('POST finish');
        session.finishedAt = finishedAt;
        return { ...session };
      },
      async lastTime(exerciseId) {
        wire.push('GET /last');
        return { exerciseId };
      },
    },
  };
}

// A log deep enough to page, answering exactly as the shipped read does: newest first on the PAIR
// (startedAt, id), strictly before the whole cursor, and `beforeId` without `before` refused as a
// bad cursor rather than half-honoured. Every query it was asked is kept, because the cursor the
// client sends IS the thing under test.
function deepLog(rows) {
  const asked = [];
  const log = rows.map((row) => ({ ...row }));
  return {
    asked,
    log,
    api: {
      async exercises() {
        return [{ id: 'back-squat', name: 'Back Squat' }];
      },
      async sessions(query = {}) {
        asked.push(query);
        if (query.beforeId !== undefined && query.before === undefined) throw new GymError(400, 'bad cursor');
        const before = query.before ?? Infinity;
        const beforeId = query.beforeId ?? '';
        return log.slice()
          .sort((left, right) => right.startedAt - left.startedAt || (left.id < right.id ? 1 : -1))
          .filter((row) => row.startedAt < before || (row.startedAt === before && row.id < beforeId))
          // The handler's own ceiling (GymApi.cpp: std::min(value, 200)), mirrored because the whole
          // `end` signal is a page coming back short of what was asked for. A LOG_PAGE raised past
          // 200 would be answered 200 by the real server and read as the bottom of the log — a fake
          // that hands back everything it was asked for would keep the suite green through it.
          .slice(0, Math.min(query.limit ?? 50, 200))
          .map((row) => ({ ...row, setCount: 0, exercises: [] }));
      },
      async session(id) {
        const row = log.find((each) => each.id === id);
        return row ? { session: { ...row }, sets: [] } : null;
      },
      async startSession({ id, startedAt }) {
        const open = log.find((row) => row.finishedAt == null);
        if (open) return { ...open };
        log.push({ id, startedAt, finishedAt: null });
        return { ...log[log.length - 1] };
      },
      async finishSession(id, { finishedAt }) {
        const row = log.find((each) => each.id === id);
        row.finishedAt = finishedAt;
        return { ...row };
      },
      async lastTime(exerciseId) {
        return { exerciseId };
      },
    },
  };
}

const PAGE = 50;

function finishedRows(count, newest, mark = 'a') {
  return Array.from({ length: count }, (each, index) => {
    const startedAt = newest - index * 86400_000;
    return { id: `ses_${mark}${String(index).padStart(3, '0')}`, startedAt, finishedAt: startedAt + HOUR };
  });
}

async function open(t, api) {
  const { useLiveSession } = await import('../../../../src/products/gym/logger/useLiveSession.js');
  const view = renderHook(t, () => useLiveSession({ api }));
  await settle();
  return view;
}

// The blob `writeLive` actually writes, with one thing at a time replaceable — every resume test
// below reads as "that blob, except this field is wrong", which is exactly the shape of the harm.
function liveBlob(fields) {
  return JSON.stringify({
    sessionId: 'ses_probe',
    order: ['back-squat'],
    exIdx: 0,
    weight: 82.5,
    reps: 8,
    restStartedAt: null,
    ...fields,
  });
}

// A set the log already holds, exactly as `GET /sessions/:id` hands it back.
function loggedSet(index, at, weightKg) {
  return {
    id: `set_stored${index}`,
    exerciseId: 'back-squat',
    weightKg,
    reps: 5,
    kind: 'working',
    completedAt: at,
    setNumber: index + 1,
  };
}

const RESUME_LOST = 'Couldn’t read where you left off — that’s the weight and the movement, never a set.';

function heldSet(index, at) {
  return {
    setId: `set_offline${index}`,
    sessionId: 'ses_probe',
    exerciseId: 'back-squat',
    weightKg: 100 + index * 2.5,
    reps: 5,
    kind: 'working',
    completedAt: at,
    attempts: 0,
    remints: 0,
    heldUntil: at + 9000,
  };
}

// LOGGED IN A BASEMENT, OPENED IN THE MORNING. GET /sessions settles a session idle four hours, so
// the app's own first read is what closes the session the queued sets belong to — and a set that
// arrives after that close is refused forever. Order alone decides whether three sets live or die.
test('the queue goes out before the boot read, so an auto-close cannot eat the night’s sets', async (t) => {
  const now = Date.now();
  const held = [0, 1, 2].map((index) => heldSet(index, now - 5 * HOUR + index * 60_000));
  const browser = browserWith({ queue: held });
  const backend = logThatSettles({ startedAt: now - 5 * HOUR, lastActivityAt: now - 5 * HOUR + 120_000 });

  const view = await open(t, backend.api);

  assert.deepEqual(backend.wire, [
    'POST sets set_offline0',
    'POST sets set_offline1',
    'POST sets set_offline2',
    'GET /exercises',
    'GET /sessions',
  ]);
  assert.deepEqual(backend.stored.map((set) => [set.id, set.weightKg]), [
    ['set_offline0', 100], ['set_offline1', 102.5], ['set_offline2', 105],
  ]);
  assert.deepEqual(view.live.refusals, []);
  assert.deepEqual(browser.held(), []);
});

// THE NUMBER UNDER THE THUMB. The 64px button reads the weight back because a gym is loud and
// there are no haptics — so an answer that lands late and relabels it is the one thing that can
// write a set the lifter did not perform. The log has no update and no delete.
test('a late last-time reply never moves a weight the lifter has already dialled', async (t) => {
  const now = Date.now();
  browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  let answer;
  backend.api.lastTime = (exerciseId) => new Promise((resolve) => {
    answer = () => resolve({
      exerciseId,
      session: { id: 'ses_last', startedAt: now - 7 * 86400_000, finishedAt: now - 7 * 86400_000 },
      sets: [
        { id: 's1', exerciseId, weightKg: 82.5, reps: 9, kind: 'working', setNumber: 1, completedAt: now - 7 * 86400_000 },
        { id: 's2', exerciseId, weightKg: 97.5, reps: 4, kind: 'working', setNumber: 2, completedAt: now - 7 * 86400_000 + 60_000 },
      ],
    });
  });

  const view = await open(t, backend.api);
  view.live.chooseMovement('back-squat');
  await settle();
  assert.deepEqual([view.live.weight, view.live.reps], [20, 5]);

  view.live.stepWeight(1, false);
  view.live.stepWeight(1, false);
  view.live.stepReps(1);
  assert.deepEqual([view.live.weight, view.live.reps], [24, 6]);

  answer();
  await settle();
  assert.deepEqual([view.live.weight, view.live.reps], [24, 6]);
  // The card is the log's to correct; the dial is not.
  assert.equal(view.live.lastTime.session.id, 'ses_last');
});

test('a late last-time reply never moves a weight the lifter typed on the keypad', async (t) => {
  const now = Date.now();
  browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  let answer;
  backend.api.lastTime = (exerciseId) => new Promise((resolve) => {
    answer = () => resolve({
      exerciseId,
      session: { id: 'ses_last', startedAt: now - 86400_000, finishedAt: now - 86400_000 },
      sets: [{ id: 's1', exerciseId, weightKg: 97.5, reps: 9, kind: 'working', setNumber: 1, completedAt: now - 86400_000 }],
    });
  });

  const view = await open(t, backend.api);
  view.live.chooseMovement('back-squat');
  await settle();
  view.live.setWeight(60);
  view.live.setReps(3);
  answer();
  await settle();
  assert.deepEqual([view.live.weight, view.live.reps], [60, 3]);
});

// The other half of the same rule: an untouched movement MUST take the answer, or the prefill —
// the product's soul, on screen before you touch anything — stops working.
test('an untouched movement still dials to what the log answers', async (t) => {
  const now = Date.now();
  browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  backend.api.lastTime = async (exerciseId) => ({
    exerciseId,
    session: { id: 'ses_last', startedAt: now - 86400_000, finishedAt: now - 86400_000 },
    sets: [
      { id: 's1', exerciseId, weightKg: 82.5, reps: 9, kind: 'working', setNumber: 1, completedAt: now - 86400_000 },
      { id: 's2', exerciseId, weightKg: 97.5, reps: 4, kind: 'working', setNumber: 2, completedAt: now - 86400_000 + 1000 },
    ],
  });

  const view = await open(t, backend.api);
  view.live.chooseMovement('back-squat');
  await settle();
  // The weight comes from the LAST working set, the reps from the FIRST — §4.1's deliberate asymmetry.
  assert.deepEqual([view.live.weight, view.live.reps], [97.5, 9]);
});

test('an answer for the movement the lifter has left never dials the one they moved to', async (t) => {
  const now = Date.now();
  browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  const gates = new Map();
  backend.api.lastTime = (exerciseId) => new Promise((resolve) => gates.set(exerciseId, resolve));

  const view = await open(t, backend.api);
  view.live.chooseMovement('back-squat');
  await settle();
  view.live.chooseMovement('bench-press');
  await settle();

  gates.get('back-squat')({
    exerciseId: 'back-squat',
    session: { id: 'ses_squat', startedAt: now - 86400_000, finishedAt: now - 86400_000 },
    sets: [{ id: 's1', exerciseId: 'back-squat', weightKg: 140, reps: 3, kind: 'working', setNumber: 1, completedAt: now - 86400_000 }],
  });
  await settle();

  assert.equal(view.live.exercise.id, 'bench-press');
  assert.deepEqual([view.live.weight, view.live.reps], [20, 5]);
  assert.equal(view.live.lastTime, null);
});

// `on this device` is the product's one durability-honesty surface. Driven off a retry counter, a
// set inside its undo window and a set behind a jam both read as durable — they have been
// attempted zero times, and neither has left the phone.
test('every set still in the queue draws as saved on this device, attempted or not', async (t) => {
  const now = Date.now();
  browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  backend.api.appendSet = async () => { throw new GymError(503, 'internal error'); };

  const view = await open(t, backend.api);
  view.live.chooseMovement('back-squat');
  await settle();
  view.live.logSet();
  view.live.logSet();
  view.live.logSet();
  await settle();

  const queued = view.live.sets.filter((set) => set.queued);
  assert.equal(queued.length, 3);
  assert.deepEqual(queued.map((set) => view.live.stalled.has(set.id)), [true, true, true]);
  assert.equal(view.live.offline, false);
});

// Finish is a round trip. A set logged into it lands in a session that closes underneath, and the
// next flush is answered 409 session-finished — terminal, and the set is gone.
test('nothing can be logged into a session that is closing, and the lifter is told where it goes', async (t) => {
  const now = Date.now();
  const browser = browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  let release;
  const closing = new Promise((resolve) => { release = resolve; });
  const finishSession = backend.api.finishSession;
  backend.api.finishSession = async (...args) => { await closing; return finishSession(...args); };

  const view = await open(t, backend.api);
  view.live.chooseMovement('back-squat');
  await settle();

  const finishing = view.live.finish();
  await settle();
  assert.equal(view.live.finishing, true);

  view.live.logSet();
  assert.equal(view.live.toast.text, 'The session is closing — log that set in the next one.');
  assert.deepEqual(browser.held(), []);
  assert.deepEqual(view.live.sets, []);

  release();
  await finishing;
  await settle();
  assert.equal(view.live.finishing, false);
  assert.deepEqual(backend.stored, []);
});

// Pocketing the phone used to force the queue out, which made the set durable inside the window
// the canon promises Undo — the pill stayed drawn and could only answer that the log already had it.
test('pocketing the phone does not spend the undo window', async (t) => {
  const now = Date.now();
  const browser = browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });

  const view = await open(t, backend.api);
  view.live.chooseMovement('back-squat');
  await settle();
  view.live.logSet();
  await settle();

  browser.hide();
  await settle();
  assert.deepEqual(backend.stored, []);
  assert.equal(browser.held().length, 1);

  assert.notEqual(view.live.undo, null);
  view.live.undoLast();
  await settle();
  assert.equal(view.live.toast.text, 'Set removed');
  assert.deepEqual(view.live.sets, []);
  assert.deepEqual(browser.held(), []);
});

// The one case where Undo cannot win: the send was already in the air — which is reachable exactly
// when the store refused the bytes and the hold went with it. The log is append-only, so the row
// comes back rather than the history holding a set the screen denies.
test('a set that reached the log while Undo was taking it back comes back to the screen', async (t) => {
  const now = Date.now();
  const browser = browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  let release;
  const inFlight = new Promise((resolve) => { release = resolve; });
  const appendSet = backend.api.appendSet;
  backend.api.appendSet = async (...args) => { await inFlight; return appendSet(...args); };

  const view = await open(t, backend.api);
  view.live.chooseMovement('back-squat');
  await settle();
  globalThis.window.localStorage.setItem = () => { throw new Error('quota'); };
  view.live.logSet();
  await settle();

  view.live.undoLast();
  assert.deepEqual(view.live.sets, []);
  assert.equal(view.live.toast.text, 'Set removed');

  release();
  await settle();

  assert.equal(backend.stored.length, 1);
  assert.deepEqual(view.live.sets.map((set) => [set.weightKg, set.reps, set.queued]), [[20, 5, false]]);
  assert.equal(view.live.toast.text, 'That set already reached the log — it stays in your history.');
  assert.deepEqual(browser.held(), []);
});

// The harmful sentence: Finish telling the lifter a set is "saved on this device" and to wait,
// when the device refused it and the only copy is this tab's memory — which waiting is what loses.
test('Finish never claims a set is saved on a device that refused to store it', async (t) => {
  const now = Date.now();
  browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  backend.api.appendSet = async () => { throw new GymError(503, 'internal error'); };

  const view = await open(t, backend.api);
  view.live.chooseMovement('back-squat');
  await settle();
  globalThis.window.localStorage.setItem = () => { throw new Error('quota'); };
  view.live.logSet();
  await settle();

  await view.live.finish();
  await settle();
  assert.equal(
    view.live.toast.text,
    '1 set is not on the log, and this device wouldn’t store it. Stay here until the log answers.',
  );
  assert.equal(view.live.finishing, false);
  assert.equal(backend.session.finishedAt, null);
});

// A store that refused the bytes is holding nothing: the row would read `on this device` while the
// only copy of the set is this tab's memory. Say so, and send it now rather than after the hold.
test('a device that will not store the set says so, and the set goes out at once', async (t) => {
  const now = Date.now();
  browserWith({});
  globalThis.window.localStorage.setItem = () => { throw new Error('quota'); };
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });

  const view = await open(t, backend.api);
  view.live.chooseMovement('back-squat');
  await settle();
  view.live.logSet();
  assert.equal(
    view.live.toast.text,
    'This device wouldn’t store that set — keep the app open until it reaches the log.',
  );

  await settle();
  assert.deepEqual(backend.stored.map((set) => [set.weightKg, set.reps]), [[20, 5]]);
});

// THE WALK DOWN THE LOG. The cursor is the last row in hand and BOTH halves of it — the server
// refuses an id with no instant, and an instant with no id cannot express a tie.
test('the next page is asked for with both halves of the cursor, taken from the last row in hand', async (t) => {
  const now = Date.now();
  browserWith({});
  const rows = finishedRows(120, now);
  const backend = deepLog(rows);

  const view = await open(t, backend.api);
  assert.equal(view.live.older.status, 'more');
  assert.deepEqual(view.live.summaries.map((each) => each.id), rows.slice(0, PAGE).map((each) => each.id));

  const tail = rows[PAGE - 1];
  await view.live.older.load();
  await settle();

  assert.deepEqual(backend.asked, [
    { limit: PAGE },
    { before: tail.startedAt, beforeId: tail.id, limit: PAGE },
  ]);
  // Appended, nothing merged: the pair is stable, so no row crosses a page edge between two reads.
  assert.deepEqual(view.live.summaries.map((each) => each.id), rows.slice(0, 2 * PAGE).map((each) => each.id));
  assert.equal(view.live.older.status, 'more');
});

// A first page of three sessions is the whole log. Offering to load older ones over it is a promise
// the read has already answered.
test('a first page shorter than one full page is the bottom of the log', async (t) => {
  const now = Date.now();
  browserWith({});
  const rows = finishedRows(3, now);
  const backend = deepLog(rows);

  const view = await open(t, backend.api);

  assert.deepEqual(backend.asked, [{ limit: PAGE }]);
  assert.deepEqual(view.live.summaries.map((each) => each.id), rows.map((each) => each.id));
  assert.equal(view.live.older.status, 'end');
});

// The exactly-divisible log: a full page can only mean "maybe more", and the empty page under it is
// what settles the question. Nothing here can tell them apart in advance.
test('a full first page offers more, and the empty page under it is the bottom', async (t) => {
  const now = Date.now();
  browserWith({});
  const rows = finishedRows(PAGE, now);
  const backend = deepLog(rows);

  const view = await open(t, backend.api);
  assert.equal(view.live.older.status, 'more');

  const tail = rows[PAGE - 1];
  await view.live.older.load();
  await settle();

  assert.deepEqual(backend.asked, [
    { limit: PAGE },
    { before: tail.startedAt, beforeId: tail.id, limit: PAGE },
  ]);
  assert.deepEqual(view.live.summaries.map((each) => each.id), rows.map((each) => each.id));
  assert.equal(view.live.older.status, 'end');
});

// THE CASE THE ID HALF EXISTS FOR. Two sessions share a start instant and the page edge falls
// between them — near-certain now that lift-import has bulk-loaded coarse timestamps.
test('two sessions sharing an instant across a page edge both land, in order and once each', async (t) => {
  const now = Date.now();
  browserWith({});
  const tie = now - 90 * 86400_000;
  const rows = [
    ...finishedRows(PAGE - 1, now),
    { id: 'ses_tieB', startedAt: tie, finishedAt: tie + HOUR },
    { id: 'ses_tieA', startedAt: tie, finishedAt: tie + HOUR },
    ...finishedRows(2, tie - 86400_000, 'z'),
  ];
  const backend = deepLog(rows);

  const view = await open(t, backend.api);
  await view.live.older.load();
  await settle();

  // The harm first: a broken cursor is a session that vanished out of the lifter's history, and the
  // failure should say that rather than report a changed query string.
  const walked = view.live.summaries.map((each) => each.id);
  assert.deepEqual(walked, rows.map((each) => each.id));
  assert.equal(new Set(walked).size, rows.length);
  assert.equal(view.live.older.status, 'end');
  assert.deepEqual(backend.asked, [
    { limit: PAGE },
    { before: tie, beforeId: 'ses_tieB', limit: PAGE },
  ]);

  // What the id half buys, stated against the same server: an instant-only cursor puts ses_tieA in
  // no page, ever — it is not before the instant, and page one stopped above it.
  const halfCursor = await backend.api.sessions({ before: tie, limit: PAGE });
  assert.deepEqual(halfCursor.map((each) => each.id), ['ses_z000', 'ses_z001']);
});

// An older page is its own read. Failing it must not blank the sessions already on screen, and must
// not say the LOG failed — the log is right there, and only the step deeper did not come back.
test('an older page that does not come back leaves the log on screen, and can be asked again', async (t) => {
  const now = Date.now();
  browserWith({});
  const rows = finishedRows(60, now);
  const backend = deepLog(rows);
  let signal = false;
  const answering = backend.api.sessions;
  backend.api.sessions = async (query) => {
    if (!signal && query.before !== undefined) {
      backend.asked.push(query);
      throw new GymError(503, 'internal error');
    }
    return answering(query);
  };

  const view = await open(t, backend.api);
  await view.live.older.load();
  await settle();

  assert.equal(view.live.older.status, 'failed');
  assert.equal(view.live.phase, 'idle');
  assert.deepEqual(view.live.summaries.map((each) => each.id), rows.slice(0, PAGE).map((each) => each.id));

  signal = true;
  await view.live.older.load();
  await settle();

  const tail = rows[PAGE - 1];
  assert.deepEqual(backend.asked, [
    { limit: PAGE },
    { before: tail.startedAt, beforeId: tail.id, limit: PAGE },
    { before: tail.startedAt, beforeId: tail.id, limit: PAGE },
  ]);
  assert.deepEqual(view.live.summaries.map((each) => each.id), rows.map((each) => each.id));
  assert.equal(view.live.older.status, 'end');
});

// Finishing hands the lifter to the log with their new session on top — which truncates a list they
// had already read to the bottom. The walk resets with the list, or the log keeps saying there is
// nothing older over rows it has just dropped.
test('finishing resets the list to page one and the walk down it with the list', async (t) => {
  const now = Date.now();
  browserWith({});
  const rows = finishedRows(60, now - 86400_000);
  const backend = deepLog(rows);

  const view = await open(t, backend.api);
  await view.live.older.load();
  await settle();
  assert.deepEqual(view.live.summaries.map((each) => each.id), rows.map((each) => each.id));
  assert.equal(view.live.older.status, 'end');

  await view.live.start();
  await settle();
  assert.equal(view.live.phase, 'live');
  const trained = view.live.session.id;

  await view.live.finish();
  await settle();

  assert.equal(view.live.phase, 'idle');
  assert.deepEqual(
    view.live.summaries.map((each) => each.id),
    [trained, ...rows.slice(0, PAGE - 1).map((each) => each.id)],
  );
  assert.equal(view.live.older.status, 'more');
});

// The same reset, with an older page already in the air: that page continues a list that no longer
// exists — page one has a new session on top of it now — so appending it would silently drop the
// session the new top row pushed off the end. It is dropped instead.
test('an older page in flight when the log is re-read from the top is not appended to the new list', async (t) => {
  const now = Date.now();
  browserWith({});
  const rows = finishedRows(60, now - 86400_000);
  const backend = deepLog(rows);
  let release;
  const gated = new Promise((resolve) => { release = resolve; });
  const answering = backend.api.sessions;
  backend.api.sessions = async (query) => {
    if (query.before !== undefined) await gated;
    return answering(query);
  };

  const view = await open(t, backend.api);
  const walking = view.live.older.load();
  await settle();
  assert.equal(view.live.older.status, 'loading');

  await view.live.start();
  await settle();
  const trained = view.live.session.id;
  await view.live.finish();
  await settle();

  release();
  await walking;
  await settle();

  assert.deepEqual(
    view.live.summaries.map((each) => each.id),
    [trained, ...rows.slice(0, PAGE - 1).map((each) => each.id)],
  );
  assert.equal(view.live.older.status, 'more');
});

// A second press while the first page is still in the air. The cursor has not moved — the list has
// not grown yet — so an unguarded second call asks the identical question and appends the same fifty
// sessions twice: the one way this walk can put a duplicate in a lifter's history. The guard is read
// off the state the caller last saw, which is what a press after the busy state is drawn holds.
test('a second press while a page is in the air sends nothing, and the page lands once', async (t) => {
  const now = Date.now();
  browserWith({});
  const rows = finishedRows(120, now);
  const backend = deepLog(rows);

  const view = await open(t, backend.api);
  const pressed = view.live.older.load();
  assert.equal(view.live.older.status, 'loading');
  const again = view.live.older.load();
  await Promise.all([pressed, again]);
  await settle();

  const walked = view.live.summaries.map((each) => each.id);
  assert.deepEqual(walked, rows.slice(0, 2 * PAGE).map((each) => each.id));
  assert.equal(new Set(walked).size, 2 * PAGE);
  const tail = rows[PAGE - 1];
  assert.deepEqual(backend.asked, [
    { limit: PAGE },
    { before: tail.startedAt, beforeId: tail.id, limit: PAGE },
  ]);
});

// The knot the two guards tie between them: an older page is in the air, finishing orphans it, and
// the re-read meant to replace the list fails too. The stale page drops silently by design — so if
// the failed re-read is also silent, nothing is left to release the foot and it sits at "Loading
// older sessions…" until a reload, over a log the lifter can still walk.
test('a failed re-read after finishing still releases the foot of the log', async (t) => {
  const now = Date.now();
  browserWith({});
  const rows = finishedRows(60, now - 86400_000);
  const backend = deepLog(rows);
  let release;
  const gated = new Promise((resolve) => { release = resolve; });
  let refuseTop = false;
  const answering = backend.api.sessions;
  backend.api.sessions = async (query) => {
    if (query.before !== undefined) await gated;
    if (query.before === undefined && refuseTop) throw new GymError(503, 'internal error');
    return answering(query);
  };

  const view = await open(t, backend.api);
  const walking = view.live.older.load();
  await settle();
  assert.equal(view.live.older.status, 'loading');

  refuseTop = true;
  await view.live.start();
  await settle();
  await view.live.finish();
  await settle();

  release();
  await walking;
  await settle();

  assert.equal(view.live.older.status, 'more');
  assert.deepEqual(view.live.summaries.map((each) => each.id), rows.slice(0, PAGE).map((each) => each.id));
});

// THE RESUME DOOR. A phone reloads mid-workout — the tab is discarded under a locked screen, the
// browser updates, the lifter pulls to refresh — and everything about where they were comes back
// through one `JSON.parse` of a key any build may have written. The regression that matters most is
// this one: a well-formed blob still restores exactly as it always did.
test('a well-formed resume blob comes back exactly as it was written', async (t) => {
  const now = Date.now();
  const restStartedAt = now - 300_000;
  const browser = browserWith({
    live: liveBlob({ order: ['bench-press', 'back-squat'], exIdx: 0, weight: 82.5, reps: 8, restStartedAt }),
  });
  const backend = logThatSettles({
    startedAt: now - HOUR,
    lastActivityAt: now - 120_000,
    sets: [loggedSet(0, now - 120_000, 100)],
  });

  const view = await open(t, backend.api);

  assert.equal(view.live.phase, 'live');
  assert.deepEqual(view.live.order, ['bench-press', 'back-squat']);
  assert.equal(view.live.exIdx, 0);
  assert.equal(view.live.exercise.id, 'bench-press');
  // The dial is the lifter's and the prefill stayed out of its way — an untouched bench-press
  // would read the empty bar, 20 × 5.
  assert.deepEqual([view.live.weight, view.live.reps], [82.5, 8]);
  assert.equal(view.live.rest.label, 'rest done · target 3:00');
  assert.equal(view.live.rest.overrun, true);
  assert.equal(view.live.toast, null);
  // Every field the writer writes, back out of the store unchanged after the restore.
  assert.deepEqual(JSON.parse(browser.kept()), {
    sessionId: 'ses_probe',
    order: ['bench-press', 'back-squat'],
    exIdx: 0,
    weight: 82.5,
    reps: 8,
    restStartedAt,
  });
});

// A load is signed here — band-assisted work sits below zero — so a door that quietly required a
// positive number would throw away every chin-up session on the first reload.
test('a band-assisted weight is a point on the number line, and survives the door as one', async (t) => {
  const now = Date.now();
  browserWith({ live: liveBlob({ order: ['chin-up'], weight: -20, reps: 6 }) });
  const backend = logThatSettles({ startedAt: now - HOUR, lastActivityAt: now - 120_000 });

  const view = await open(t, backend.api);

  assert.equal(view.live.exercise.id, 'chin-up');
  assert.deepEqual([view.live.weight, view.live.reps], [-20, 6]);
  assert.equal(view.live.toast, null);
});

// Not JSON at all: a write a killed tab cut in half. Nothing can be salvaged, so nothing is — and
// the session is rebuilt from the log, which is where the sets were the whole time.
test('a resume blob that is not JSON is discarded, and the session comes back off the log', async (t) => {
  const now = Date.now();
  browserWith({ live: '{"sessionId":"ses_probe","order":["back-' });
  const backend = logThatSettles({
    startedAt: now - HOUR,
    lastActivityAt: now - 120_000,
    sets: [loggedSet(0, now - 180_000, 100), loggedSet(1, now - 120_000, 105)],
  });

  const view = await open(t, backend.api);

  assert.equal(view.live.phase, 'live');
  assert.deepEqual(view.live.sets.map((set) => [set.id, set.weightKg, set.queued]), [
    ['set_stored0', 100, false], ['set_stored1', 105, false],
  ]);
  assert.deepEqual(view.live.order, ['back-squat']);
  // The prefill is the recovery: today's own last set is a better number than any default.
  assert.deepEqual([view.live.weight, view.live.reps], [105, 5]);
  assert.equal(view.live.toast.text, RESUME_LOST);
});

// Valid JSON, wrong type. `setWeight('82.5')` reaches `ladderLabels` during render and prints a
// ladder read off a string; the 64px button under the thumb then reads back a weight nobody dialled.
test('a weight that is not a number never reaches the ladder', async (t) => {
  const now = Date.now();
  browserWith({ live: liveBlob({ weight: '82.5' }) });
  const backend = logThatSettles({ startedAt: now - HOUR, lastActivityAt: now - 120_000 });

  const view = await open(t, backend.api);

  // The place survived — only the dial did not.
  assert.deepEqual(view.live.order, ['back-squat']);
  assert.equal(view.live.exercise.id, 'back-squat');
  assert.deepEqual([view.live.weight, view.live.reps], [20, 5]);
  assert.equal(view.live.toast.text, RESUME_LOST);
});

// The dial is ONE gesture. Restoring the half that typechecks and prefilling the other half puts a
// pair on the button that the lifter never dialled — 82.5 × 5 when they were about to do 82.5 × 8.
test('the dial comes back whole or not at all', async (t) => {
  const now = Date.now();
  browserWith({ live: liveBlob({ weight: 82.5, reps: null }) });
  const backend = logThatSettles({ startedAt: now - HOUR, lastActivityAt: now - 120_000 });

  const view = await open(t, backend.api);

  assert.deepEqual([view.live.weight, view.live.reps], [20, 5]);
  assert.equal(view.live.toast.text, RESUME_LOST);
});

// A blob written before the rep floor moved can hold reps: 0 — a value the ladder no longer reaches
// and parseEntry now refuses. Restoring it would open the pad in alarm ink on a gesture the lifter
// never made, so it fails the same way any other broken dial does: the pair goes, the prefill answers.
test('a stored rep count the server would refuse takes the dial down with it', async (t) => {
  const now = Date.now();
  browserWith({ live: liveBlob({ weight: 82.5, reps: 0 }) });
  const backend = logThatSettles({ startedAt: now - HOUR, lastActivityAt: now - 120_000 });

  const view = await open(t, backend.api);

  assert.deepEqual([view.live.weight, view.live.reps], [20, 5]);
  assert.equal(view.live.toast.text, RESUME_LOST);
});

// A movement list that is a bare string spreads into its own characters, and the logger opens on a
// movement called "b". The list is the one thing here that can rebuild itself, so it does.
test('a movement list that is not a list is rebuilt from the sets that were performed', async (t) => {
  const now = Date.now();
  browserWith({ live: liveBlob({ order: 'back-squat' }) });
  const backend = logThatSettles({
    startedAt: now - HOUR,
    lastActivityAt: now - 120_000,
    sets: [loggedSet(0, now - 120_000, 100)],
  });

  const view = await open(t, backend.api);

  assert.deepEqual(view.live.order, ['back-squat']);
  assert.equal(view.live.exercise.id, 'back-squat');
  // The place and the dial are separate facts: losing the list does not cost the number.
  assert.deepEqual([view.live.weight, view.live.reps], [82.5, 8]);
  assert.equal(view.live.toast.text, RESUME_LOST);
});

// An index is a pointer INTO the list, and a build that once wrote the movement id there leaves one
// that reads as NaN through the clamp — which selects no movement at all and draws the ad-hoc
// screen over a live session. The list outlives the index; the index falls back to the movement
// last performed, which is where a session with no blob at all opens.
test('an index that is not an index costs the index and not the list', async (t) => {
  const now = Date.now();
  browserWith({ live: liveBlob({ order: ['bench-press', 'back-squat'], exIdx: 'back-squat' }) });
  const backend = logThatSettles({ startedAt: now - HOUR, lastActivityAt: now - 120_000 });

  const view = await open(t, backend.api);

  assert.deepEqual(view.live.order, ['bench-press', 'back-squat']);
  assert.equal(view.live.exIdx, 1);
  assert.equal(view.live.exercise.id, 'back-squat');
  assert.deepEqual([view.live.weight, view.live.reps], [82.5, 8]);
  assert.equal(view.live.toast.text, RESUME_LOST);
});

// THE ONE THAT MATTERS. The resume blob and the flush queue are DIFFERENT KEYS, and only the queue
// holds sets — so a blob thrown away at the door cannot take a set with it. Proved with the network
// refusing every write, which is the state where those sets exist on this device and nowhere else.
test('a discarded resume blob cannot drop a set the queue is still holding', async (t) => {
  const now = Date.now();
  const held = [0, 1, 2].map((index) => heldSet(index, now - 600_000 + index * 60_000));
  const browser = browserWith({ queue: held, live: 'not json, not anything' });
  const backend = logThatSettles({ startedAt: now - HOUR, lastActivityAt: now - 120_000 });
  backend.api.appendSet = async () => { throw new GymError(503, 'internal error'); };

  const view = await open(t, backend.api);

  assert.equal(view.live.phase, 'live');
  assert.deepEqual(view.live.sets.map((set) => [set.id, set.weightKg, set.queued]), [
    ['set_offline0', 100, true], ['set_offline1', 102.5, true], ['set_offline2', 105, true],
  ]);
  assert.deepEqual([...view.live.stalled], ['set_offline0', 'set_offline1', 'set_offline2']);
  assert.deepEqual(browser.held().map((entry) => entry.setId), [
    'set_offline0', 'set_offline1', 'set_offline2',
  ]);
  assert.deepEqual(view.live.refusals, []);
  // The queued sets rebuilt the list AND the number: the discard cost the dial, and they replaced it.
  assert.deepEqual(view.live.order, ['back-squat']);
  assert.deepEqual([view.live.weight, view.live.reps], [105, 5]);
  assert.equal(view.live.toast.text, RESUME_LOST);
});

// A blob that names some other session is not damage and never was — a session finished on the
// phone leaves one behind, and the web opening a different session simply starts from the log.
// Nothing was lost, so nothing is said.
test('a resume blob for a session that is not this one is ignored without a word', async (t) => {
  const now = Date.now();
  browserWith({ live: liveBlob({ sessionId: 'ses_elsewhere', order: ['bench-press'] }) });
  const backend = logThatSettles({
    startedAt: now - HOUR,
    lastActivityAt: now - 120_000,
    sets: [loggedSet(0, now - 120_000, 100)],
  });

  const view = await open(t, backend.api);

  assert.deepEqual(view.live.order, ['back-squat']);
  assert.deepEqual([view.live.weight, view.live.reps], [100, 5]);
  assert.equal(view.live.toast, null);
});

// A list naming the same movement twice shortens under adopt's dedupe while the index keeps counting
// the long version, so the lifter resumes on the wrong lift. The list is repairable; the pointer into
// it is not, and the collapse is said rather than swallowed.
test('a movement listed twice costs the index, not the list, and is not silent', async (t) => {
  const now = Date.now();
  browserWith({ live: liveBlob({ order: ['bench-press', 'bench-press', 'back-squat'], exIdx: 1 }) });
  const backend = logThatSettles({ startedAt: now - HOUR, lastActivityAt: now - 120_000 });

  const view = await open(t, backend.api);

  assert.deepEqual(view.live.order, ['bench-press', 'back-squat']);
  assert.equal(view.live.toast.text, RESUME_LOST);
});

// THE CARD MUST NOT KEEP CLAIMING TO BE READING. A prefill read that never came back leaves the
// only surface that could say so saying "reading your log…" instead — for the rest of the session,
// over a movement whose history the log never denied. The hook is the only thing that knows, so it
// is the hook that has to say it.
test('a last-time read that never answers is surfaced, not swallowed', async (t) => {
  const now = Date.now();
  browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  backend.api.lastTime = async () => { throw new GymError(503, 'could not read the log'); };

  const view = await open(t, backend.api);
  view.live.chooseMovement('back-squat');
  await settle();

  assert.equal(view.live.lastTime, null);
  assert.equal(view.live.lastTimeFailed, true);
  // The dial is the empty bar either way: a failure is not a training fact, and the prefill has
  // nothing better to offer than the number it opens on.
  assert.deepEqual([view.live.weight, view.live.reps], [20, 5]);
});

// The flag belongs to the movement under the thumb. A failure that lands after the lifter has
// walked to the next one would otherwise draw "the log didn't answer" over a read still in flight.
test('a failure for the movement the lifter has left never marks the one they moved to', async (t) => {
  const now = Date.now();
  browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  const gates = new Map();
  backend.api.lastTime = (exerciseId) => new Promise((resolve, reject) => gates.set(exerciseId, reject));

  const view = await open(t, backend.api);
  view.live.chooseMovement('back-squat');
  await settle();
  view.live.chooseMovement('bench-press');
  await settle();

  gates.get('back-squat')(new GymError(503, 'could not read the log'));
  await settle();

  assert.equal(view.live.exercise.id, 'bench-press');
  assert.equal(view.live.lastTimeFailed, false);

  // And the movement that is standing there when its own read fails does raise it.
  gates.get('bench-press')(new GymError(503, 'could not read the log'));
  await settle();
  assert.equal(view.live.lastTimeFailed, true);
});

// A session running against a frozen plan, and the routine that plan was frozen FROM — the two
// halves the mid-session question needs. It notices the bar disagreed by reading the snapshot, and
// changes the program by re-reading the routine, because the snapshot stopped moving at the start.
function planned({ startedAt }) {
  const wire = [];
  const session = {
    id: 'ses_plan',
    startedAt,
    finishedAt: null,
    routineId: 'rt_push_a',
    plan: {
      routine: 'Push A',
      entries: [
        { exerciseId: 'bench-press', sets: 5, reps: 5, weightKg: 82.5 },
        { exerciseId: 'chin-up', sets: 3, reps: 8 },
      ],
    },
  };
  const routine = {
    id: 'rt_push_a',
    name: 'Push A',
    position: 0,
    lastTrainedAt: startedAt,
    entries: [
      { position: 1, exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5, restSeconds: 180 },
      { position: 2, exerciseId: 'chin-up', targetSets: 3, targetReps: 8 },
    ],
  };
  const stored = [];
  return {
    wire,
    session,
    stored,
    api: {
      async exercises() {
        return [{ id: 'bench-press', name: 'Bench Press' }, { id: 'chin-up', name: 'Chin-up' }];
      },
      async sessions() {
        return [{ ...session, setCount: stored.length, exercises: [] }];
      },
      async session() {
        return { session: { ...session }, sets: stored.slice() };
      },
      async appendSet(sessionId, body) {
        stored.push({ ...body, setNumber: stored.length + 1 });
        return stored[stored.length - 1];
      },
      async finishSession(id, { finishedAt }) {
        session.finishedAt = finishedAt;
        return { ...session };
      },
      async lastTime(exerciseId) {
        return { exerciseId };
      },
      async routine(id) {
        wire.push(`GET routine ${id}`);
        return JSON.parse(JSON.stringify(routine));
      },
      async replaceRoutine(id, body) {
        wire.push(`PUT routine ${id}`);
        wire.push(body);
        return { ...routine };
      },
    },
  };
}

// THE ONE QUESTION THE LOGGER ASKS, at the boundary it is asked at. The answer is a read-modify-write
// of the WHOLE routine: a PUT carrying only the changed entry would delete the rest of the program.
test('a heavier day is asked about when the movement changes, and answering rewrites the whole routine', async (t) => {
  const now = Date.now();
  browserWith();
  const store = planned({ startedAt: now - HOUR });
  const view = await open(t, store.api);
  assert.equal(view.live.phase, 'live');
  assert.equal(view.live.deviation, null);

  view.live.chooseMovement('bench-press');
  await settle();
  view.live.setWeight(87.5);
  view.live.logSet();
  await settle();
  // Standing on the movement is not leaving it: nothing is asked until the lifter moves on.
  assert.equal(view.live.deviation, null);

  view.live.chooseMovement('chin-up');
  await settle();
  assert.deepEqual(view.live.deviation, {
    exerciseId: 'bench-press',
    position: 1,
    weightKg: 87.5,
    title: 'Heavier than the plan',
    body: 'Today’s Bench Press ran at 87.5 against a planned 82.5. Today’s session already has it. Push A does not.',
    save: 'Save 87.5 to Push A',
    keep: 'Today only',
  });

  await view.live.saveDeviation();
  await settle();
  assert.equal(view.live.deviation, null);
  assert.deepEqual(store.wire.slice(0, 2), ['GET routine rt_push_a', 'PUT routine rt_push_a']);
  assert.deepEqual(store.wire[2], {
    id: 'rt_push_a',
    name: 'Push A',
    position: 0,
    entries: [
      { exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 87.5, restSeconds: 180 },
      { exerciseId: 'chin-up', targetSets: 3, targetReps: 8 },
    ],
  });

  // Once a session, whatever the answer was: the lifter came back, went heavier again, and left
  // again — and the sheet does not return.
  view.live.chooseMovement('bench-press');
  await settle();
  view.live.setWeight(92.5);
  view.live.logSet();
  await settle();
  view.live.chooseMovement('chin-up');
  await settle();
  assert.equal(view.live.deviation, null);
  assert.equal(store.wire.length, 3);
});

// The finish screen replaces the redirect-and-a-toast: what happened is a whole surface now, and
// saying it twice — once quietly, over the screen that says it properly — is the thing being fixed.
test('finishing lands on the end of the session it just closed, and says nothing on the way', async (t) => {
  const now = Date.now();
  const browser = browserWith();
  const store = logThatSettles({ startedAt: now - HOUR, lastActivityAt: now - 60_000 });
  const view = await open(t, store.api);
  assert.equal(view.live.phase, 'live');

  view.live.chooseMovement('back-squat');
  await settle();
  view.live.logSet();
  await settle();

  await view.live.finish();
  await settle();
  assert.equal(view.live.phase, 'idle');
  assert.equal(view.live.session, null);
  assert.equal(globalThis.window.location.hash, '#/gym/finish/ses_probe');
  assert.equal(view.live.toast, null);
  // The resume blob goes with the session, and the queue is empty because Finish waited for it.
  assert.equal(browser.kept(), null);
  assert.deepEqual(browser.held(), []);
});

// THE LOGGER CAN WRITE A WARMUP, which neither live logger could until 2026-08-06 — only backfill
// and the Lift import ever set a kind. It was a phase-2 gap and a correctness bug: the record rules
// read `kind == 'working'` and the prefill read exists precisely to exclude warmups, so a 40 kg
// ramp-up logged as working became the prior mark to beat and the number the next set carried
// forward — the product's single highest-value pixel, answered with a lie.
test('a warmup is logged as one, counts toward no target, and is never carried forward', async (t) => {
  const now = Date.now();
  browserWith();
  const store = planned({ startedAt: now - HOUR });
  const view = await open(t, store.api);
  view.live.chooseMovement('bench-press');
  await settle();

  // The plan holds the opening number, and no working set has happened yet.
  assert.deepEqual([view.live.weight, view.live.reps], [82.5, 5]);
  assert.equal(view.live.workingToday, 0);

  view.live.setWeight(40);
  view.live.setReps(10);
  assert.equal(view.live.logSet('warmup'), true);
  await settle();
  assert.deepEqual(view.live.sets.map((set) => [set.weightKg, set.reps, set.kind]), [[40, 10, 'warmup']]);
  // It advances no counter, and it is not the weight the next set starts from: the plan still is.
  assert.equal(view.live.workingToday, 0);
  assert.deepEqual(view.live.todaySets.map((set) => set.kind), ['warmup']);

  view.live.chooseMovement('chin-up');
  await settle();
  view.live.chooseMovement('bench-press');
  await settle();
  assert.deepEqual([view.live.weight, view.live.reps], [82.5, 5]);

  // A working set does all three of those things, from the same door.
  view.live.setWeight(85);
  view.live.setReps(5);
  assert.equal(view.live.logSet('working'), true);
  await settle();
  assert.equal(view.live.workingToday, 1);

  view.live.chooseMovement('chin-up');
  await settle();
  view.live.chooseMovement('bench-press');
  await settle();
  assert.deepEqual([view.live.weight, view.live.reps], [85, 5]);
});

// The chip disarms on the set it armed and on no other, so the answer has to say whether one
// happened: a lifter told the session is closing has not spent the gesture, and the next tap in the
// next session would otherwise write a working set they had asked to be a warmup.
test('logSet answers whether a set happened, so an armed warmup is not spent on a refusal', async (t) => {
  const now = Date.now();
  browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  let release;
  const closing = new Promise((resolve) => { release = resolve; });
  const finishSession = backend.api.finishSession;
  backend.api.finishSession = async (...args) => { await closing; return finishSession(...args); };

  const view = await open(t, backend.api);
  view.live.chooseMovement('back-squat');
  await settle();
  assert.equal(view.live.logSet('working'), true);
  await settle();

  const finishing = view.live.finish();
  await settle();
  assert.equal(view.live.finishing, true);
  assert.equal(view.live.logSet('warmup'), false);
  assert.equal(view.live.toast.text, 'The session is closing — log that set in the next one.');
  release();
  await finishing;
  await settle();
});
