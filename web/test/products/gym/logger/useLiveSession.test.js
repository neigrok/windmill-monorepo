// The live session, driven for real. This is the one file in gym where the pure rules meet the
// network, the clock and the browser's storage, and the four things pinned here are the four ways
// a lifter's set has actually been lost or falsified:
//   · the queue goes out BEFORE the boot read, because the read is what auto-closes the session;
//   · a late `last time` never moves a number the lifter has already dialled;
//   · every set still in the queue draws as saved on this device, attempted or not;
//   · nothing can be logged into a session that is closing, and pocketing the phone does not
//     spend the undo window.
//
// React is driven through its own dispatcher rather than a DOM: the hook is the unit under test,
// effects run where React runs them, and every state change re-renders synchronously.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { GymError } from '../../../../src/products/gym/gymApi.js';

const { ReactCurrentDispatcher } = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
const HOUR = 3600_000;

function renderHook(run) {
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
  return {
    get live() { return result; },
    unmount() { cells.forEach((cell) => cell.cleanup?.()); },
  };
}

const settle = async (turns = 4) => {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

function browserWith({ queue = [] } = {}) {
  const disk = new Map();
  if (queue.length > 0) disk.set('windmill.gym.queue', JSON.stringify(queue));
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

async function open(api) {
  const { useLiveSession } = await import('../../../../src/products/gym/logger/useLiveSession.js');
  const view = renderHook(() => useLiveSession({ api }));
  await settle();
  return view;
}

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
test('the queue goes out before the boot read, so an auto-close cannot eat the night’s sets', async () => {
  const now = Date.now();
  const held = [0, 1, 2].map((index) => heldSet(index, now - 5 * HOUR + index * 60_000));
  const browser = browserWith({ queue: held });
  const backend = logThatSettles({ startedAt: now - 5 * HOUR, lastActivityAt: now - 5 * HOUR + 120_000 });

  const view = await open(backend.api);

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
  view.unmount();
});

// THE NUMBER UNDER THE THUMB. The 64px button reads the weight back because a gym is loud and
// there are no haptics — so an answer that lands late and relabels it is the one thing that can
// write a set the lifter did not perform. The log has no update and no delete.
test('a late last-time reply never moves a weight the lifter has already dialled', async () => {
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

  const view = await open(backend.api);
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
  view.unmount();
});

test('a late last-time reply never moves a weight the lifter typed on the keypad', async () => {
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

  const view = await open(backend.api);
  view.live.chooseMovement('back-squat');
  await settle();
  view.live.setWeight(60);
  view.live.setReps(3);
  answer();
  await settle();
  assert.deepEqual([view.live.weight, view.live.reps], [60, 3]);
  view.unmount();
});

// The other half of the same rule: an untouched movement MUST take the answer, or the prefill —
// the product's soul, on screen before you touch anything — stops working.
test('an untouched movement still dials to what the log answers', async () => {
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

  const view = await open(backend.api);
  view.live.chooseMovement('back-squat');
  await settle();
  // The weight comes from the LAST working set, the reps from the FIRST — §4.1's deliberate asymmetry.
  assert.deepEqual([view.live.weight, view.live.reps], [97.5, 9]);
  view.unmount();
});

test('an answer for the movement the lifter has left never dials the one they moved to', async () => {
  const now = Date.now();
  browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  const gates = new Map();
  backend.api.lastTime = (exerciseId) => new Promise((resolve) => gates.set(exerciseId, resolve));

  const view = await open(backend.api);
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
  view.unmount();
});

// `on this device` is the product's one durability-honesty surface. Driven off a retry counter, a
// set inside its undo window and a set behind a jam both read as durable — they have been
// attempted zero times, and neither has left the phone.
test('every set still in the queue draws as saved on this device, attempted or not', async () => {
  const now = Date.now();
  browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  backend.api.appendSet = async () => { throw new GymError(503, 'internal error'); };

  const view = await open(backend.api);
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
  view.unmount();
});

// Finish is a round trip. A set logged into it lands in a session that closes underneath, and the
// next flush is answered 409 session-finished — terminal, and the set is gone.
test('nothing can be logged into a session that is closing, and the lifter is told where it goes', async () => {
  const now = Date.now();
  const browser = browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  let release;
  const closing = new Promise((resolve) => { release = resolve; });
  const finishSession = backend.api.finishSession;
  backend.api.finishSession = async (...args) => { await closing; return finishSession(...args); };

  const view = await open(backend.api);
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
  view.unmount();
});

// Pocketing the phone used to force the queue out, which made the set durable inside the window
// the canon promises Undo — the pill stayed drawn and could only answer that the log already had it.
test('pocketing the phone does not spend the undo window', async () => {
  const now = Date.now();
  const browser = browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });

  const view = await open(backend.api);
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
  view.unmount();
});

// The one case where Undo cannot win: the send was already in the air — which is reachable exactly
// when the store refused the bytes and the hold went with it. The log is append-only, so the row
// comes back rather than the history holding a set the screen denies.
test('a set that reached the log while Undo was taking it back comes back to the screen', async () => {
  const now = Date.now();
  const browser = browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  let release;
  const inFlight = new Promise((resolve) => { release = resolve; });
  const appendSet = backend.api.appendSet;
  backend.api.appendSet = async (...args) => { await inFlight; return appendSet(...args); };

  const view = await open(backend.api);
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
  view.unmount();
});

// The harmful sentence: Finish telling the lifter a set is "saved on this device" and to wait,
// when the device refused it and the only copy is this tab's memory — which waiting is what loses.
test('Finish never claims a set is saved on a device that refused to store it', async () => {
  const now = Date.now();
  browserWith({});
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });
  backend.api.appendSet = async () => { throw new GymError(503, 'internal error'); };

  const view = await open(backend.api);
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
  view.unmount();
});

// A store that refused the bytes is holding nothing: the row would read `on this device` while the
// only copy of the set is this tab's memory. Say so, and send it now rather than after the hold.
test('a device that will not store the set says so, and the set goes out at once', async () => {
  const now = Date.now();
  browserWith({});
  globalThis.window.localStorage.setItem = () => { throw new Error('quota'); };
  const backend = logThatSettles({ startedAt: now - 60_000, lastActivityAt: now - 60_000 });

  const view = await open(backend.api);
  view.live.chooseMovement('back-squat');
  await settle();
  view.live.logSet();
  assert.equal(
    view.live.toast.text,
    'This device wouldn’t store that set — keep the app open until it reaches the log.',
  );

  await settle();
  assert.deepEqual(backend.stored.map((set) => [set.weightKg, set.reps]), [[20, 5]]);
  view.unmount();
});
