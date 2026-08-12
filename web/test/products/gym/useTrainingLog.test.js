// The training log's shared read, driven for real. Web gym is the mirror and the desk (§11): the
// boot read finds the open session and POLLS it read-only, and everything else here is the walk
// down the log. What is pinned is what can silently lose history or falsify the mirror:
//   · the walk down the log pages on the PAIR (startedAt, id), because an instant-only cursor
//     leaves a tied session in no page, ever;
//   · the mirror polls only while the tab is visible, refetches the moment it comes back, and
//     never survives the session it shows closing on the phone;
//   · the poll rides the read's weak ETag — the last reply's tag goes up as If-None-Match, and a
//     304 leaves the state in hand untouched, no re-render over a workout that did not move;
//   · the retired web logger's resume note is cleared on boot, and the old offline queue's bytes
//     are NOT — whatever sets a pre-mirror build still owed the log are the lifter's.
//
// React is driven through its own dispatcher rather than a DOM: the hook is the unit under test,
// effects run where React runs them, and every state change re-renders synchronously.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { GymError, UNCHANGED } from '../../../src/products/gym/gymApi.js';

const { ReactCurrentDispatcher } = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
const HOUR = 3600_000;
const POLL_MS = 5000;
// The toast's own five seconds, which are also the seconds a withheld delete can be taken back in
// (`UNDO_MS`, fix.js — screens.test.js pins the two constants equal). They are the same number on
// purpose, and that is precisely why the test below exists.
const TOAST_MS = 5000;

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
    get log() { return result; },
  };
}

const settle = async (turns = 4) => {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

// `live` and `queue` are seeded as RAW BYTES: what a pre-mirror build left behind is a foreign
// input, and the boot's only business with either key is remove-one, touch-nothing-else.
function browserWith({ queue = null, live = null } = {}) {
  const disk = new Map();
  if (queue !== null) disk.set('windmill.gym.queue', queue);
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
    held: () => (disk.has('windmill.gym.queue') ? disk.get('windmill.gym.queue') : null),
    kept: () => (disk.has('windmill.gym.live') ? disk.get('windmill.gym.live') : null),
    hide: () => {
      globalThis.document.visibilityState = 'hidden';
      (listeners.get('visibilitychange') ?? []).forEach((fn) => fn());
    },
    show: () => {
      globalThis.document.visibilityState = 'visible';
      (listeners.get('visibilitychange') ?? []).forEach((fn) => fn());
    },
    // The signal coming back, exactly as the browser announces it. A listener that was never bound
    // hears nothing, which is the whole of what the failed-boot test below is asking about.
    reconnect: () => {
      globalThis.navigator.onLine = true;
      (listeners.get('online') ?? []).forEach((fn) => fn());
    },
  };
}

// A log holding one open session — the phone's workout, as GET /sessions and GET /sessions/:id
// answer it. `wire` keeps every request so a test can say exactly what polled and what did not.
function phoneWorkout({ startedAt, sets = [] }) {
  const wire = [];
  const session = { id: 'ses_phone', startedAt, finishedAt: null };
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
        return [{ ...session, setCount: stored.length, exercises: [] }];
      },
      async session(id) {
        wire.push(`GET /sessions/${id}`);
        return { session: { ...session }, sets: stored.slice() };
      },
      async createExercise(body) {
        wire.push(`POST /exercises ${body.name}`);
        return { ...body };
      },
    },
  };
}

// The same phone workout, over a log that speaks the freshness contract the server speaks: every
// 200 hands back a weak tag — opaque bytes the hook must only ever echo, which is why this fake
// minting a shape of its own is fine — and a read that sends the current tag back up is answered
// UNCHANGED with no detail at all. `asked` keeps the tag each detail read carried, because the
// ride itself is what the tests below assert.
function taggedWorkout({ startedAt, sets = [] }) {
  const asked = [];
  const session = { id: 'ses_phone', startedAt, finishedAt: null };
  const stored = [...sets];
  const tagOf = () =>
    `W/"${stored.length}-${stored.length === 0 ? 0 : stored[stored.length - 1].completedAt}-${session.finishedAt ?? 0}"`;
  return {
    asked,
    session,
    stored,
    tagOf,
    api: {
      async exercises() {
        return [{ id: 'back-squat', name: 'Back Squat' }];
      },
      async sessions() {
        return [{ ...session, setCount: stored.length, exercises: [] }];
      },
      async session(id, { etag } = {}) {
        asked.push(etag ?? null);
        if (etag === tagOf()) return UNCHANGED;
        return { session: { ...session }, sets: stored.slice(), etag: tagOf() };
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

// A set the log already holds, exactly as `GET /sessions/:id` hands it back.
function loggedSet(index, at, weightKg, exerciseId = 'back-squat') {
  return {
    id: `set_stored${index}`,
    exerciseId,
    weightKg,
    reps: 5,
    kind: 'working',
    completedAt: at,
    setNumber: index + 1,
  };
}

async function open(t, api) {
  const { useTrainingLog } = await import('../../../src/products/gym/useTrainingLog.js');
  const view = renderHook(t, () => useTrainingLog({ api }));
  await settle();
  return view;
}

// THE MIRROR OPENS ON THE BOOT READ. An open session on the log is a workout running on the phone;
// the web holds it read-only — nothing on the returned surface can write into it, because nothing
// on the returned surface writes sets at all.
test('the boot read finds the open session, and the mirror holds it with its sets', async (t) => {
  const now = Date.now();
  browserWith();
  const backend = phoneWorkout({
    startedAt: now - HOUR,
    sets: [loggedSet(0, now - 300_000, 100), loggedSet(1, now - 120_000, 102.5)],
  });

  const view = await open(t, backend.api);

  assert.equal(view.log.phase, 'ready');
  assert.equal(view.log.session.id, 'ses_phone');
  assert.equal(view.log.session.finishedAt, null);
  assert.deepEqual(view.log.sets.map((set) => [set.id, set.weightKg, set.setNumber]), [
    ['set_stored0', 100, 1], ['set_stored1', 102.5, 2],
  ]);
  assert.deepEqual(backend.wire, ['GET /exercises', 'GET /sessions', 'GET /sessions/ses_phone']);
});

test('a log with nothing open is ready, with no session and no detail read', async (t) => {
  const now = Date.now();
  browserWith();
  const backend = deepLog(finishedRows(3, now));

  const view = await open(t, backend.api);

  assert.equal(view.log.phase, 'ready');
  assert.equal(view.log.session, null);
  assert.deepEqual(view.log.sets, []);
  assert.deepEqual(backend.asked, [{ limit: PAGE }]);
});

// THE RETIRED KEYS. The resume note held no sets and no build writes it any more — cleared, so it
// cannot claim forever that a workout is open here. The old offline queue is the opposite case:
// anything under it is sets a pre-mirror build still owed the log, and the boot may not destroy a
// lifter's sets, so those bytes are left exactly as found.
test('the boot clears the retired resume note and leaves the old queue bytes alone', async (t) => {
  const now = Date.now();
  const browser = browserWith({
    live: '{"sessionId":"ses_old","order":["back-squat"],"exIdx":0}',
    queue: '[{"setId":"set_owed","sessionId":"ses_old","weightKg":100}]',
  });
  const backend = deepLog(finishedRows(1, now));

  await open(t, backend.api);

  assert.equal(browser.kept(), null);
  assert.equal(browser.held(), '[{"setId":"set_owed","sessionId":"ses_old","weightKg":100}]');
});

// 'failed' is the one phase nothing else leaves — the boot read is the only door into the log — so
// the signal returning has to ask it again, or a lifter who opened the log underground stays on the
// failure screen while the signal comes back around them.
test('the signal returning asks a failed boot read again, and the mirror opens', async (t) => {
  const now = Date.now();
  const browser = browserWith();
  const backend = phoneWorkout({ startedAt: now - HOUR, sets: [loggedSet(0, now - 120_000, 100)] });
  const sessions = backend.api.sessions;
  let underground = true;
  backend.api.sessions = async (query) => {
    if (underground) throw new GymError(503, 'the log didn’t answer');
    return sessions(query);
  };

  const view = await open(t, backend.api);
  assert.equal(view.log.phase, 'failed');
  assert.equal(view.log.session, null);

  underground = false;
  browser.reconnect();
  await settle();

  assert.equal(view.log.phase, 'ready');
  assert.equal(view.log.session.id, 'ses_phone');
});

// The detail read fails like a poll, not like the boot: the log itself LOADED, so the surface
// opens over the summaries that landed — 'failed' over a loaded log would strand the lifter, since
// its one recovery is the 'online' event, which a server-side 5xx flap never fires.
test('a failed detail read of the open session does not fail a boot that loaded the log', async (t) => {
  const now = Date.now();
  browserWith();
  const backend = phoneWorkout({ startedAt: now - HOUR, sets: [loggedSet(0, now - 120_000, 100)] });
  backend.api.session = async (id) => {
    backend.wire.push(`GET /sessions/${id}`);
    throw new GymError(503, 'the log didn’t answer');
  };

  const view = await open(t, backend.api);

  assert.equal(view.log.phase, 'ready');
  assert.equal(view.log.session, null);
  assert.deepEqual(view.log.sets, []);
  assert.deepEqual(view.log.summaries.map((each) => each.id), ['ses_phone']);
  assert.deepEqual(backend.wire, ['GET /exercises', 'GET /sessions', 'GET /sessions/ses_phone']);
});

// THE POLL (§11.3 flow 2): five seconds, visible tab only, no new endpoint. The facts on the
// mirror only move when the poll answers, so the poll answering IS the mirror staying true.
test('the mirror polls the open session every five seconds and takes what the log answers', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const now = Date.now();
  browserWith();
  const backend = phoneWorkout({ startedAt: now - HOUR, sets: [loggedSet(0, now - 300_000, 100)] });

  const view = await open(t, backend.api);
  assert.deepEqual(backend.wire, ['GET /exercises', 'GET /sessions', 'GET /sessions/ses_phone']);

  backend.stored.push(loggedSet(1, now - 30_000, 102.5));
  t.mock.timers.tick(POLL_MS);
  await settle();

  assert.deepEqual(backend.wire, [
    'GET /exercises', 'GET /sessions', 'GET /sessions/ses_phone', 'GET /sessions/ses_phone',
  ]);
  assert.deepEqual(view.log.sets.map((set) => set.id), ['set_stored0', 'set_stored1']);

  t.mock.timers.tick(POLL_MS);
  await settle();
  assert.deepEqual(backend.wire.filter((line) => line === 'GET /sessions/ses_phone').length, 3);
});

// THE FRESHNESS RIDE, first half: the boot's detail read carries no tag — there is nothing in hand
// yet — and every beat after it sends the last reply's tag back. While nobody lifted, the answer is
// a 304 and the mirror replaces NOTHING: the very same objects stay on the surface, which is the
// no-re-render promise stated as identity rather than as a spy on React.
test('the first poll sends the boot read’s tag, and a 304 leaves the state in hand untouched', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const now = Date.now();
  browserWith();
  const backend = taggedWorkout({ startedAt: now - HOUR, sets: [loggedSet(0, now - 300_000, 100)] });
  const bootTag = backend.tagOf();

  const view = await open(t, backend.api);
  assert.deepEqual(backend.asked, [null]);
  const heldSession = view.log.session;
  const heldSets = view.log.sets;

  t.mock.timers.tick(POLL_MS);
  await settle();
  t.mock.timers.tick(POLL_MS);
  await settle();

  assert.deepEqual(backend.asked, [null, bootTag, bootTag]);
  assert.equal(view.log.session, heldSession);
  assert.equal(view.log.sets, heldSets);
});

// THE FRESHNESS RIDE, second half: a set landing on the phone unmatches the tag, the next beat
// takes the full read, and the beat after that asks with the NEW tag — proving the mirror moves
// its tag with every 200 it takes, not just the boot's.
test('a set landing after a 304 reaches the mirror on the next beat, under the new tag', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const now = Date.now();
  browserWith();
  const backend = taggedWorkout({ startedAt: now - HOUR, sets: [loggedSet(0, now - 300_000, 100)] });
  const bootTag = backend.tagOf();

  const view = await open(t, backend.api);
  t.mock.timers.tick(POLL_MS);
  await settle();
  assert.deepEqual(backend.asked, [null, bootTag]);

  backend.stored.push(loggedSet(1, now - 10_000, 105));
  const grownTag = backend.tagOf();
  t.mock.timers.tick(POLL_MS);
  await settle();
  assert.deepEqual(view.log.sets.map((set) => set.id), ['set_stored0', 'set_stored1']);
  const heldSets = view.log.sets;

  t.mock.timers.tick(POLL_MS);
  await settle();
  assert.deepEqual(backend.asked, [null, bootTag, bootTag, grownTag]);
  assert.equal(view.log.sets, heldSets);
});

// A hidden tab asks no questions, and the moment it comes back it asks at once rather than waiting
// out a poll interval — a lifter glancing at a laptop mid-set is the whole audience of this panel.
test('a hidden tab stops the poll, and coming back refetches at once', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const now = Date.now();
  const browser = browserWith();
  const backend = phoneWorkout({ startedAt: now - HOUR, sets: [loggedSet(0, now - 300_000, 100)] });

  const view = await open(t, backend.api);
  const polled = () => backend.wire.filter((line) => line === 'GET /sessions/ses_phone').length;
  assert.equal(polled(), 1);

  browser.hide();
  t.mock.timers.tick(POLL_MS);
  t.mock.timers.tick(POLL_MS);
  await settle();
  assert.equal(polled(), 1);

  backend.stored.push(loggedSet(1, now - 30_000, 102.5));
  browser.show();
  await settle();
  assert.equal(polled(), 2);
  assert.deepEqual(view.log.sets.map((set) => set.id), ['set_stored0', 'set_stored1']);
});

// The phone finishing the workout is the mirror's end, not its failure: the panel goes, and the
// log is re-read from the top so the closed session appears where it now belongs.
test('the session finishing on the phone ends the mirror and re-reads the log', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const now = Date.now();
  browserWith();
  const backend = phoneWorkout({ startedAt: now - HOUR, sets: [loggedSet(0, now - 300_000, 100)] });

  const view = await open(t, backend.api);
  assert.equal(view.log.session.id, 'ses_phone');

  backend.session.finishedAt = now;
  t.mock.timers.tick(POLL_MS);
  await settle();

  assert.equal(view.log.session, null);
  assert.deepEqual(view.log.sets, []);
  // The re-read from the top: one more GET /sessions after the boot's own.
  assert.equal(backend.wire.filter((line) => line === 'GET /sessions').length, 2);
  assert.equal(view.log.summaries[0].finishedAt, now);
});

// A poll that fails is a signal fact, not a session fact: "last set 3:40 ago" is still true, the
// panel keeps the last answered read, and the next beat is the retry.
test('a poll that does not come back keeps the last true read on the mirror', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const now = Date.now();
  browserWith();
  const backend = phoneWorkout({ startedAt: now - HOUR, sets: [loggedSet(0, now - 300_000, 100)] });

  const view = await open(t, backend.api);
  let basement = true;
  backend.api.session = async () => {
    backend.wire.push('GET /sessions/ses_phone');
    if (basement) throw new GymError(503, 'the log didn’t answer');
    return { session: { ...backend.session }, sets: backend.stored.slice() };
  };

  t.mock.timers.tick(POLL_MS);
  await settle();
  assert.equal(view.log.session.id, 'ses_phone');
  assert.deepEqual(view.log.sets.map((set) => set.id), ['set_stored0']);
  assert.equal(view.log.toast, null);

  basement = false;
  backend.stored.push(loggedSet(1, now - 10_000, 105));
  t.mock.timers.tick(POLL_MS);
  await settle();
  assert.deepEqual(view.log.sets.map((set) => set.id), ['set_stored0', 'set_stored1']);
});

// THE WALK DOWN THE LOG. The cursor is the last row in hand and BOTH halves of it — the server
// refuses an id with no instant, and an instant with no id cannot express a tie.
test('the next page is asked for with both halves of the cursor, taken from the last row in hand', async (t) => {
  const now = Date.now();
  browserWith();
  const rows = finishedRows(120, now);
  const backend = deepLog(rows);

  const view = await open(t, backend.api);
  assert.equal(view.log.older.status, 'more');
  assert.deepEqual(view.log.summaries.map((each) => each.id), rows.slice(0, PAGE).map((each) => each.id));

  const tail = rows[PAGE - 1];
  await view.log.older.load();
  await settle();

  assert.deepEqual(backend.asked, [
    { limit: PAGE },
    { before: tail.startedAt, beforeId: tail.id, limit: PAGE },
  ]);
  // Appended, nothing merged: the pair is stable, so no row crosses a page edge between two reads.
  assert.deepEqual(view.log.summaries.map((each) => each.id), rows.slice(0, 2 * PAGE).map((each) => each.id));
  assert.equal(view.log.older.status, 'more');
});

// A first page of three sessions is the whole log. Offering to load older ones over it is a promise
// the read has already answered.
test('a first page shorter than one full page is the bottom of the log', async (t) => {
  const now = Date.now();
  browserWith();
  const rows = finishedRows(3, now);
  const backend = deepLog(rows);

  const view = await open(t, backend.api);

  assert.deepEqual(backend.asked, [{ limit: PAGE }]);
  assert.deepEqual(view.log.summaries.map((each) => each.id), rows.map((each) => each.id));
  assert.equal(view.log.older.status, 'end');
});

// The exactly-divisible log: a full page can only mean "maybe more", and the empty page under it is
// what settles the question. Nothing here can tell them apart in advance.
test('a full first page offers more, and the empty page under it is the bottom', async (t) => {
  const now = Date.now();
  browserWith();
  const rows = finishedRows(PAGE, now);
  const backend = deepLog(rows);

  const view = await open(t, backend.api);
  assert.equal(view.log.older.status, 'more');

  const tail = rows[PAGE - 1];
  await view.log.older.load();
  await settle();

  assert.deepEqual(backend.asked, [
    { limit: PAGE },
    { before: tail.startedAt, beforeId: tail.id, limit: PAGE },
  ]);
  assert.deepEqual(view.log.summaries.map((each) => each.id), rows.map((each) => each.id));
  assert.equal(view.log.older.status, 'end');
});

// THE CASE THE ID HALF EXISTS FOR. Two sessions share a start instant and the page edge falls
// between them — near-certain now that lift-import has bulk-loaded coarse timestamps.
test('two sessions sharing an instant across a page edge both land, in order and once each', async (t) => {
  const now = Date.now();
  browserWith();
  const tie = now - 90 * 86400_000;
  const rows = [
    ...finishedRows(PAGE - 1, now),
    { id: 'ses_tieB', startedAt: tie, finishedAt: tie + HOUR },
    { id: 'ses_tieA', startedAt: tie, finishedAt: tie + HOUR },
    ...finishedRows(2, tie - 86400_000, 'z'),
  ];
  const backend = deepLog(rows);

  const view = await open(t, backend.api);
  await view.log.older.load();
  await settle();

  // The harm first: a broken cursor is a session that vanished out of the lifter's history, and the
  // failure should say that rather than report a changed query string.
  const walked = view.log.summaries.map((each) => each.id);
  assert.deepEqual(walked, rows.map((each) => each.id));
  assert.equal(new Set(walked).size, rows.length);
  assert.equal(view.log.older.status, 'end');
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
  browserWith();
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
  await view.log.older.load();
  await settle();

  assert.equal(view.log.older.status, 'failed');
  assert.equal(view.log.phase, 'ready');
  assert.deepEqual(view.log.summaries.map((each) => each.id), rows.slice(0, PAGE).map((each) => each.id));

  signal = true;
  await view.log.older.load();
  await settle();

  const tail = rows[PAGE - 1];
  assert.deepEqual(backend.asked, [
    { limit: PAGE },
    { before: tail.startedAt, beforeId: tail.id, limit: PAGE },
    { before: tail.startedAt, beforeId: tail.id, limit: PAGE },
  ]);
  assert.deepEqual(view.log.summaries.map((each) => each.id), rows.map((each) => each.id));
  assert.equal(view.log.older.status, 'end');
});

// A second press while the first page is still in the air. The cursor has not moved — the list has
// not grown yet — so an unguarded second call asks the identical question and appends the same fifty
// sessions twice: the one way this walk can put a duplicate in a lifter's history. The guard is read
// off the state the caller last saw, which is what a press after the busy state is drawn holds.
test('a second press while a page is in the air sends nothing, and the page lands once', async (t) => {
  const now = Date.now();
  browserWith();
  const rows = finishedRows(120, now);
  const backend = deepLog(rows);

  const view = await open(t, backend.api);
  const pressed = view.log.older.load();
  assert.equal(view.log.older.status, 'loading');
  const again = view.log.older.load();
  await Promise.all([pressed, again]);
  await settle();

  const walked = view.log.summaries.map((each) => each.id);
  assert.deepEqual(walked, rows.slice(0, 2 * PAGE).map((each) => each.id));
  assert.equal(new Set(walked).size, 2 * PAGE);
  const tail = rows[PAGE - 1];
  assert.deepEqual(backend.asked, [
    { limit: PAGE },
    { before: tail.startedAt, beforeId: tail.id, limit: PAGE },
  ]);
});

// RELOAD ORPHANS THE PAGE IN THE AIR. A backfill landing re-reads the log from the top — which
// truncates a list the lifter may have read to the bottom, so the walk resets with the list, and
// an older page still in flight continues a tail the reload has just thrown away: appended, it
// would silently drop the row the new top pushed off the end.
test('an older page in flight when the log is re-read from the top is not appended to the new list', async (t) => {
  const now = Date.now();
  browserWith();
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
  const walking = view.log.older.load();
  await settle();
  assert.equal(view.log.older.status, 'loading');

  // What a backfill save does: a new session lands, and the list is re-read from the top.
  const fresh = { id: 'ses_backfill', startedAt: now, finishedAt: now + HOUR };
  backend.log.unshift(fresh);
  await view.log.reloadLog();
  await settle();

  release();
  await walking;
  await settle();

  assert.deepEqual(
    view.log.summaries.map((each) => each.id),
    ['ses_backfill', ...rows.slice(0, PAGE - 1).map((each) => each.id)],
  );
  assert.equal(view.log.older.status, 'more');
});

// The knot the two guards tie between them: an older page is in the air, a reload orphans it, and
// the re-read meant to replace the list fails too. The stale page drops silently by design — so if
// the failed re-read is also silent, nothing is left to release the foot and it sits at "Loading
// older sessions…" until a reload, over a log the lifter can still walk.
test('a failed re-read from the top still releases the foot of the log', async (t) => {
  const now = Date.now();
  browserWith();
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
  const walking = view.log.older.load();
  await settle();
  assert.equal(view.log.older.status, 'loading');

  refuseTop = true;
  await view.log.reloadLog();
  await settle();

  release();
  await walking;
  await settle();

  assert.equal(view.log.older.status, 'more');
  assert.deepEqual(view.log.summaries.map((each) => each.id), rows.slice(0, PAGE).map((each) => each.id));
});

// THE ONE VOICE MUST NOT SWALLOW ITS OWN NEXT SENTENCE, and the caller that makes this a live
// hazard rather than a curiosity is the withheld delete (§G18): its DELETE is sent when its five
// seconds close, and those are the SAME five seconds a toast is up for. So a delete the log refuses
// — being offline is exactly this — speaks in the instant the toast holding its Undo is due to
// expire, and each sentence must get its own window rather than the remainder of the one before it.
//
// The far edge of that — the older clock firing AFTER the newer sentence is already state — cannot
// be driven here: this harness renders synchronously, so the effect's cleanup always cancels the
// old timer before it can run. That ordering is React's own, and the shape that survives it is read
// off the source in screens.test.js and driven for real in the wave's browser harness.
test('a second sentence replaces the first and is up for its own five seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = Date.now();
  browserWith();
  const backend = deepLog(finishedRows(1, now));
  const view = await open(t, backend.api);

  view.log.say('47.5 × 4 is out of the log.', { label: 'Undo', run() {} });
  assert.equal(view.log.toast.action.label, 'Undo');

  t.mock.timers.tick(TOAST_MS - 1);
  assert.equal(view.log.toast.text, '47.5 × 4 is out of the log.');

  // The refusal, said one millisecond before the toast that offered the Undo would have gone.
  view.log.say('That set is still in the log — the log didn’t answer. Try again when you have signal.');
  assert.equal(view.log.toast.action, null);

  // Past the instant the first toast was due, and one millisecond short of its own: still up.
  t.mock.timers.tick(TOAST_MS - 1);
  assert.equal(
    view.log.toast.text,
    'That set is still in the log — the log didn’t answer. Try again when you have signal.',
  );
  t.mock.timers.tick(1);
  assert.equal(view.log.toast, null);
});

// A CORRECTION MOVES A ROW WHEREVER IT SITS, and the desk is where somebody goes back three months
// to make one (§G18). Every other caller of the re-read moves page ONE — a backfill, a discard, the
// mirror closing — so a re-read of the top fifty was right for them and wrong for this one twice
// over: it threw away the pages the lifter had walked, AND the page it did read could not contain
// the row it was fired to move. Read to the depth the log is actually open to, both hold.
test('the log re-read after a correction is as deep as the walk, and carries the row that moved', async (t) => {
  const now = Date.now();
  browserWith();
  const rows = finishedRows(300, now - 86400_000);
  const backend = deepLog(rows);

  const view = await open(t, backend.api);
  await view.log.older.load();
  await settle();
  await view.log.older.load();
  await settle();
  assert.equal(view.log.summaries.length, 150);

  backend.asked.length = 0;
  await view.log.reloadLog();
  await settle();

  assert.deepEqual(backend.asked, [{ limit: 150 }]);
  assert.deepEqual(view.log.summaries.map((each) => each.id), rows.slice(0, 150).map((each) => each.id));
  // The row a correction on the third page would have moved is in the read that followed it — which
  // is the whole of what a re-read of the top fifty could not say.
  assert.equal(view.log.summaries.some((each) => each.id === rows[120].id), true);
  assert.equal(view.log.older.status, 'more');

  // Past the handler's own ceiling the tail is still truncated, and the foot says so rather than
  // claiming the log ends where the clamp did: asking for more than the server will answer is the
  // one thing that would turn a short page into a lie.
  await view.log.older.load();
  await settle();
  await view.log.older.load();
  await settle();
  assert.equal(view.log.summaries.length, 250);

  backend.asked.length = 0;
  await view.log.reloadLog();
  await settle();

  assert.deepEqual(backend.asked, [{ limit: 200 }]);
  assert.equal(view.log.summaries.length, 200);
  assert.equal(view.log.older.status, 'more');
});

// A movement minted from the picker lands in the one catalog instance this product has, so it is on
// every picker in the app a render later — the routine editor's and the backfill form's.
test('a created movement lands in the catalog, and a refusal is said in the one voice', async (t) => {
  const now = Date.now();
  browserWith();
  const backend = deepLog(finishedRows(1, now));
  let refuse = false;
  backend.api.createExercise = async (body) => {
    if (refuse) throw new GymError(503, 'the log didn’t answer');
    return { ...body };
  };

  const view = await open(t, backend.api);
  const made = await view.log.createMovement('  Face Pull ');
  await settle();

  assert.equal(made.name, 'Face Pull');
  assert.equal(view.log.catalog.some((each) => each.name === 'Face Pull'), true);

  refuse = true;
  const refused = await view.log.createMovement('Nope');
  await settle();
  assert.equal(refused, null);
  assert.equal(
    view.log.toast.text,
    'That movement wasn’t created — the log didn’t answer. Try again when you have signal.',
  );
});

// A 400 is the store's own answer — it read the document and would not take it — and blaming the
// signal for it invites a retry that fails identically forever. The toast speaks through
// failureReason, which keeps the two failures apart.
test('a movement the store refuses as written is not blamed on the signal', async (t) => {
  const now = Date.now();
  browserWith();
  const backend = deepLog(finishedRows(1, now));
  backend.api.createExercise = async () => {
    throw new GymError(400, 'an exercise needs a name');
  };

  const view = await open(t, backend.api);
  const refused = await view.log.createMovement('x'.repeat(300));
  await settle();

  assert.equal(refused, null);
  assert.equal(view.log.toast.text, 'That movement wasn’t created — the log wouldn’t take it as written.');
});
