import test from 'node:test';
import assert from 'node:assert/strict';

import { GymError, UNCHANGED } from '../../../src/products/gym/gymApi.js';
import { fmt } from '../../../src/products/gym/log.js';
import { DEFAULT_PREFERENCES } from '../../../src/products/gym/settings/preferences.js';
import { KG, LB, spellWeightsIn, weightUnit } from '../../../src/products/gym/units.js';
import { browserWith, renderHook, settle } from './harness.mjs';

const HOUR = 3600_000;
const POLL_MS = 5000;
const WATCH_MS = 30_000;
const TOAST_MS = 9000;

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
      async preferences() {
        wire.push('GET /preferences');
        return {};
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
      async preferences() {
        return {};
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
      async preferences() {
        return {};
      },
      async sessions(query = {}) {
        asked.push(query);
        if (query.beforeId !== undefined && query.before === undefined) throw new GymError(400, 'bad cursor');
        const before = query.before ?? Infinity;
        const beforeId = query.beforeId ?? '';
        return log.slice()
          .sort((left, right) => right.startedAt - left.startedAt || (left.id < right.id ? 1 : -1))
          .filter((row) => row.startedAt < before || (row.startedAt === before && row.id < beforeId))
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
  assert.deepEqual(backend.wire, ['GET /exercises', 'GET /sessions', 'GET /preferences', 'GET /sessions/ses_phone']);
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
  assert.deepEqual(backend.wire, ['GET /exercises', 'GET /sessions', 'GET /preferences', 'GET /sessions/ses_phone']);
});

test('the mirror polls the open session every five seconds and takes what the log answers', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const now = Date.now();
  browserWith();
  const backend = phoneWorkout({ startedAt: now - HOUR, sets: [loggedSet(0, now - 300_000, 100)] });

  const view = await open(t, backend.api);
  assert.deepEqual(backend.wire, ['GET /exercises', 'GET /sessions', 'GET /preferences', 'GET /sessions/ses_phone']);

  backend.stored.push(loggedSet(1, now - 30_000, 102.5));
  t.mock.timers.tick(POLL_MS);
  await settle();

  assert.deepEqual(backend.wire, [
    'GET /exercises', 'GET /sessions', 'GET /preferences', 'GET /sessions/ses_phone', 'GET /sessions/ses_phone',
  ]);
  assert.deepEqual(view.log.sets.map((set) => set.id), ['set_stored0', 'set_stored1']);

  t.mock.timers.tick(POLL_MS);
  await settle();
  assert.deepEqual(backend.wire.filter((line) => line === 'GET /sessions/ses_phone').length, 3);
});

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
  assert.equal(backend.wire.filter((line) => line === 'GET /sessions').length, 2);
  assert.equal(view.log.summaries[0].finishedAt, now);
});

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
  assert.equal(view.log.transient, null);

  basement = false;
  backend.stored.push(loggedSet(1, now - 10_000, 105));
  t.mock.timers.tick(POLL_MS);
  await settle();
  assert.deepEqual(view.log.sets.map((set) => set.id), ['set_stored0', 'set_stored1']);
});

test('a workout started after the tab opened is found by the watch, on the beat and on the way back', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const now = Date.now();
  const browser = browserWith();
  const backend = phoneWorkout({ startedAt: now, sets: [] });
  let started = false;
  backend.api.sessions = async (query) => {
    backend.wire.push(`GET /sessions?limit=${query.limit}`);
    if (!started) return [];
    return [{ ...backend.session, setCount: backend.stored.length, exercises: [] }];
  };

  const view = await open(t, backend.api);
  assert.equal(view.log.phase, 'ready');
  assert.equal(view.log.session, null);
  assert.deepEqual(backend.wire, ['GET /exercises', 'GET /sessions?limit=50', 'GET /preferences']);

  t.mock.timers.tick(WATCH_MS);
  await settle();
  assert.deepEqual(backend.wire.slice(3), ['GET /sessions?limit=1']);
  assert.equal(view.log.session, null);

  started = true;
  backend.stored.push(loggedSet(0, now + 60_000, 100));
  t.mock.timers.tick(WATCH_MS);
  await settle();
  assert.deepEqual(backend.wire.slice(4), ['GET /sessions?limit=1', 'GET /sessions/ses_phone']);
  assert.equal(view.log.session.id, 'ses_phone');
  assert.deepEqual(view.log.sets.map((set) => set.id), ['set_stored0']);
  assert.deepEqual(view.log.summaries, []);

  t.mock.timers.tick(WATCH_MS);
  await settle();
  assert.equal(backend.wire.slice(6).every((line) => line === 'GET /sessions/ses_phone'), true);
  assert.equal(backend.wire.slice(6).length, WATCH_MS / POLL_MS);

  browser.show();
  await settle();
  browser.hide();
  const before = backend.wire.length;
  t.mock.timers.tick(WATCH_MS);
  await settle();
  assert.equal(backend.wire.length, before);
});

test('while nothing is mirrored, coming back to the tab asks at once and a hidden tab asks nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const now = Date.now();
  const browser = browserWith();
  const backend = phoneWorkout({ startedAt: now, sets: [loggedSet(0, now + 60_000, 100)] });
  let started = false;
  backend.api.sessions = async (query) => {
    backend.wire.push(`GET /sessions?limit=${query.limit}`);
    if (!started) return [];
    return [{ ...backend.session, setCount: backend.stored.length, exercises: [] }];
  };

  const view = await open(t, backend.api);
  browser.hide();
  t.mock.timers.tick(WATCH_MS * 4);
  await settle();
  assert.deepEqual(backend.wire, ['GET /exercises', 'GET /sessions?limit=50', 'GET /preferences']);

  started = true;
  browser.show();
  await settle();
  assert.deepEqual(backend.wire.slice(3), ['GET /sessions?limit=1', 'GET /sessions/ses_phone']);
  assert.equal(view.log.session.id, 'ses_phone');
});

test('a boot whose detail read flapped is mirrored by the next beat of the watch', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const now = Date.now();
  browserWith();
  const backend = phoneWorkout({ startedAt: now - HOUR, sets: [loggedSet(0, now - 120_000, 100)] });
  let flapping = true;
  const detail = backend.api.session;
  backend.api.session = async (id, options) => {
    if (!flapping) return detail(id, options);
    backend.wire.push(`GET /sessions/${id}`);
    throw new GymError(503, 'the log didn’t answer');
  };

  const view = await open(t, backend.api);
  assert.equal(view.log.phase, 'ready');
  assert.equal(view.log.session, null);
  assert.deepEqual(view.log.summaries.map((each) => each.id), ['ses_phone']);

  flapping = false;
  t.mock.timers.tick(WATCH_MS);
  await settle();
  assert.equal(view.log.session.id, 'ses_phone');
  assert.deepEqual(view.log.sets.map((set) => set.id), ['set_stored0']);
  assert.deepEqual(backend.wire, [
    'GET /exercises', 'GET /sessions', 'GET /preferences', 'GET /sessions/ses_phone',
    'GET /sessions', 'GET /sessions/ses_phone',
  ]);
});

test('the log re-read when the mirror closes adopts the next workout it lists open', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const now = Date.now();
  browserWith();
  const workoutA = { id: 'ses_a', startedAt: now - HOUR, finishedAt: null };
  const workoutB = { id: 'ses_b', startedAt: now, finishedAt: null };
  const rows = [workoutA];
  const asked = [];
  const api = {
    async exercises() { return [{ id: 'back-squat', name: 'Back Squat' }]; },
    async preferences() { return {}; },
    async sessions(query) {
      asked.push(`GET /sessions?limit=${query.limit}`);
      return rows.slice().sort((left, right) => right.startedAt - left.startedAt)
        .map((row) => ({ ...row, setCount: 0, exercises: [] }));
    },
    async session(id) {
      asked.push(`GET /sessions/${id}`);
      const row = rows.find((each) => each.id === id);
      return { session: { ...row }, sets: id === 'ses_b' ? [loggedSet(0, now + 30_000, 60)] : [] };
    },
  };

  const view = await open(t, api);
  assert.equal(view.log.session.id, 'ses_a');

  workoutA.finishedAt = now - 60_000;
  rows.push(workoutB);
  t.mock.timers.tick(POLL_MS);
  await settle();

  assert.equal(view.log.session.id, 'ses_b');
  assert.deepEqual(view.log.sets.map((set) => set.id), ['set_stored0']);
  assert.deepEqual(view.log.summaries.map((each) => [each.id, each.finishedAt]), [['ses_b', null], ['ses_a', now - 60_000]]);
  assert.deepEqual(asked, [
    'GET /sessions?limit=50', 'GET /sessions/ses_a', 'GET /sessions/ses_a',
    'GET /sessions?limit=50', 'GET /sessions/ses_b',
  ]);
});

test('a boot answered 401 fails as signed-out and tells the frame; a 5xx fails as the server, and Retry asks again', async (t) => {
  const now = Date.now();
  browserWith();
  const backend = phoneWorkout({ startedAt: now - HOUR, sets: [] });
  const sessions = backend.api.sessions;
  let answer = () => { throw new GymError(401, 'sign in to open your training log'); };
  backend.api.sessions = async (query) => answer(query);
  const told = [];

  const { useTrainingLog } = await import('../../../src/products/gym/useTrainingLog.js');
  const view = renderHook(t, () => useTrainingLog({ api: backend.api, onSignedOut: () => told.push('signed-out') }));
  await settle();
  assert.equal(view.log.phase, 'failed');
  assert.equal(view.log.failure, 'signed-out');
  assert.deepEqual(told, ['signed-out']);

  answer = () => { throw new GymError(503, 'internal error'); };
  view.log.retryBoot();
  await settle();
  assert.equal(view.log.phase, 'failed');
  assert.equal(view.log.failure, 'server');
  assert.deepEqual(told, ['signed-out']);

  answer = () => { throw new TypeError('Failed to fetch'); };
  view.log.retryBoot();
  await settle();
  assert.equal(view.log.failure, 'signal');

  answer = sessions;
  view.log.retryBoot();
  await settle();
  assert.equal(view.log.phase, 'ready');
  assert.equal(view.log.failure, null);
  assert.equal(view.log.session.id, 'ses_phone');
});

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
  assert.deepEqual(view.log.summaries.map((each) => each.id), rows.slice(0, 2 * PAGE).map((each) => each.id));
  assert.equal(view.log.older.status, 'more');
});

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

  const walked = view.log.summaries.map((each) => each.id);
  assert.deepEqual(walked, rows.map((each) => each.id));
  assert.equal(new Set(walked).size, rows.length);
  assert.equal(view.log.older.status, 'end');
  assert.deepEqual(backend.asked, [
    { limit: PAGE },
    { before: tie, beforeId: 'ses_tieB', limit: PAGE },
  ]);

  const halfCursor = await backend.api.sessions({ before: tie, limit: PAGE });
  assert.deepEqual(halfCursor.map((each) => each.id), ['ses_z000', 'ses_z001']);
});

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

test('a second sentence replaces the first and is up for its own nine seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = Date.now();
  browserWith();
  const backend = deepLog(finishedRows(1, now));
  const view = await open(t, backend.api);

  // The voice says a sentence and carries no move of its own: the only action a transient offers is
  // the withheld window's Undo, and the window hands that over itself.
  view.log.say('47.5 × 4 is out of the log.');
  assert.equal(view.log.transient.action, null);
  assert.notEqual(view.log.transient.dismiss, null);

  t.mock.timers.tick(TOAST_MS - 1);
  assert.equal(view.log.transient.text, '47.5 × 4 is out of the log.');

  view.log.say('That set is still in the log — the log didn’t answer. Try again when you have signal.');
  assert.equal(view.log.transient.action, null);

  t.mock.timers.tick(TOAST_MS - 1);
  assert.equal(
    view.log.transient.text,
    'That set is still in the log — the log didn’t answer. Try again when you have signal.',
  );
  t.mock.timers.tick(1);
  assert.equal(view.log.transient, null);
});

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
  assert.equal(view.log.summaries.some((each) => each.id === rows[120].id), true);
  assert.equal(view.log.older.status, 'more');

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
  const made = await view.log.createMovement({ name: '  Face Pull ', equipment: 'machine' });
  await settle();

  assert.equal(made.name, 'Face Pull');
  assert.equal(view.log.catalog.some((each) => each.name === 'Face Pull'), true);
  assert.equal(made.equipment, 'machine');
  assert.equal(made.pattern, 'isolation');

  refuse = true;
  const refused = await view.log.createMovement({ name: 'Nope', equipment: 'barbell' });
  await settle();
  assert.equal(refused, null);
  assert.equal(
    view.log.transient.text,
    'That movement wasn’t created — the log didn’t answer. Try again when you have signal.',
  );
});

test('a movement the store refuses as written is not blamed on the signal', async (t) => {
  const now = Date.now();
  browserWith();
  const backend = deepLog(finishedRows(1, now));
  backend.api.createExercise = async () => {
    throw new GymError(400, 'an exercise needs a name');
  };

  const view = await open(t, backend.api);
  const refused = await view.log.createMovement({ name: 'x'.repeat(300), equipment: 'barbell' });
  await settle();

  assert.equal(refused, null);
  assert.equal(view.log.transient.text, 'That movement wasn’t created — the log wouldn’t take it as written.');
});

test('the account’s settings arrive with the log, and the unit is set before the rooms open', async (t) => {
  t.after(() => spellWeightsIn(KG));
  const now = Date.now();
  browserWith();
  const backend = deepLog(finishedRows(2, now));
  backend.api.preferences = async () => ({ units: 'lb', restSeconds: 120 });

  const view = await open(t, backend.api);

  assert.equal(view.log.phase, 'ready');
  assert.equal(view.log.preferences.units, 'lb');
  assert.equal(view.log.preferences.restSeconds, 120);
  assert.equal(view.log.preferences.confirmHaptic, true);
  assert.equal(weightUnit(), 'lb');
  assert.equal(fmt(102.5), '226');
});

test('a settings read that does not come back still opens the log, in kilograms', async (t) => {
  t.after(() => spellWeightsIn(KG));
  const now = Date.now();
  browserWith();
  const backend = deepLog(finishedRows(2, now));
  spellWeightsIn(LB);
  backend.api.preferences = async () => { throw new GymError(503, 'the log didn’t answer'); };

  const view = await open(t, backend.api);

  assert.equal(view.log.phase, 'ready');
  assert.equal(view.log.summaries.length, 2);
  assert.deepEqual(view.log.preferences, DEFAULT_PREFERENCES);
  assert.equal(weightUnit(), 'kg');
});
