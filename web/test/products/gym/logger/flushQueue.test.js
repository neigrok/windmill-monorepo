// The flush queue, pinned against the shipped backend contract. Six properties are load-bearing
// and each of them is a set somebody actually lifted:
//   · terminal and retryable are told apart by the machine code, never by the sentence;
//   · a refusal is SURFACED — a queue that swallows one silently loses a set and reports success;
//   · Finish flushes first, because a session that closed before a set reached it refuses it forever;
//   · the walk addresses entries by set id, because Undo and the next set run during a send;
//   · a set that cannot land holds up its own movement and never the workout behind it;
//   · a store that refused the bytes is not "saved on this device", and the queue says so.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GymError } from '../../../../src/products/gym/gymApi.js';
import { FlushQueue, refusalOf, verdictFor } from '../../../../src/products/gym/logger/flushQueue.js';

const START = 1_900_000_000_000;

// write() answers whether the bytes are on the device — the queue drops the undo hold when they
// are not, so a fake that shrugs would quietly disarm the thing under test.
function memoryStore(initial = []) {
  let held = initial;
  let refusing = false;
  return {
    read: () => held,
    write: (entries) => {
      if (refusing) return false;
      held = entries;
      return true;
    },
    contents: () => held,
    refuse: () => { refusing = true; },
  };
}

function apiThat(...answers) {
  const calls = [];
  let turn = 0;
  return {
    calls,
    async appendSet(sessionId, body) {
      calls.push({ sessionId, body });
      const answer = answers[Math.min(turn, answers.length - 1)];
      turn += 1;
      if (answer instanceof Error) throw answer;
      return { ...body, setNumber: turn, ...answer };
    },
  };
}

function entryOf(setId, completedAt) {
  return {
    setId, sessionId: 'ses_1', exerciseId: 'back-squat', weightKg: 102.5, reps: 5,
    kind: 'working', completedAt,
  };
}

function queueOn(api, store, clock, mint = () => 'set_reminted') {
  return new FlushQueue({ api, store, mint, now: clock, holdMs: 9000 });
}

test('verdictFor — the four verdicts come off the code and the status, never off the prose', () => {
  assert.equal(verdictFor(new GymError(409, 'reworded overnight', 'set-id-taken')), 'remint');
  assert.equal(verdictFor(new GymError(409, 'reworded overnight', 'session-finished')), 'refused');
  assert.equal(verdictFor(new GymError(409, 'reworded overnight', 'session-id-taken')), 'refused');
  assert.equal(verdictFor(new GymError(409, 'a conflict nobody has shipped yet')), 'refused');
  assert.equal(verdictFor(new GymError(400, 'could not read that set')), 'refused');
  assert.equal(verdictFor(new GymError(400, 'no such exercise', 'unknown-exercise')), 'refused');
  assert.equal(verdictFor(new GymError(500, 'internal error')), 'retry');
  assert.equal(verdictFor(new GymError(503, 'busy')), 'retry');
  assert.equal(verdictFor(new TypeError('Failed to fetch')), 'retry');
  assert.equal(verdictFor(new GymError(401, 'sign in to open your training log')), 'wait');
  assert.equal(verdictFor(new GymError(404, 'no such session')), 'wait');
});

test('refusalOf — a surfaced refusal says which of the two happened, in words', () => {
  assert.equal(
    refusalOf(new GymError(409, 'reworded overnight', 'session-finished')),
    'the session closed before this set reached it',
  );
  assert.equal(
    refusalOf(new GymError(400, 'reworded overnight', 'unknown-exercise')),
    'that movement is not in the catalog',
  );
  assert.equal(refusalOf(new GymError(400, 'could not read that set')), 'could not read that set');
});

test('the client-minted id travels as the body’s id — replay is safe by construction', async () => {
  let now = START;
  const api = apiThat({});
  const store = memoryStore();
  const queue = queueOn(api, store, () => now);
  queue.enqueue(entryOf('set_1', START));
  now += 9000;
  const report = await queue.flush();
  assert.deepEqual(api.calls, [{
    sessionId: 'ses_1',
    body: {
      id: 'set_1', exerciseId: 'back-squat', weightKg: 102.5, reps: 5, kind: 'working', completedAt: START,
    },
  }]);
  assert.equal(report.delivered.length, 1);
  assert.equal(report.delivered[0].stored.setNumber, 1);
  assert.deepEqual(report.refused, []);
  assert.deepEqual(report.pending, []);
  assert.deepEqual(store.contents(), []);
});

// The hold IS the undo window: a set the lifter may still take back has not been sent, because the
// log is append-only and there is nothing to delete it with.
test('a held set waits out its undo window, and Undo withdraws it before it ever lands', async () => {
  let now = START;
  const api = apiThat({});
  const queue = queueOn(api, memoryStore(), () => now);
  queue.enqueue(entryOf('set_1', START));
  const early = await queue.flush();
  assert.deepEqual(api.calls, []);
  assert.equal(early.pending.length, 1);

  assert.equal(queue.withdraw('set_1'), true);
  assert.equal(queue.withdraw('set_1'), false);
  now += 9000;
  const after = await queue.flush();
  assert.deepEqual(api.calls, []);
  assert.deepEqual(after.pending, []);
});

test('5xx and a dead network are retryable — the set stays queued, in order, and nothing is lost', async () => {
  let now = START;
  const api = apiThat(new GymError(503, 'could not store that set'));
  const store = memoryStore();
  const queue = queueOn(api, store, () => now);
  queue.enqueue(entryOf('set_1', START));
  queue.enqueue(entryOf('set_2', START + 60_000));
  now += 9000;

  const first = await queue.flush();
  assert.equal(api.calls.length, 1);
  assert.deepEqual(first.delivered, []);
  assert.deepEqual(first.refused, []);
  assert.deepEqual(first.pending.map((entry) => entry.setId), ['set_1', 'set_2']);
  assert.equal(first.pending[0].attempts, 1);
  assert.deepEqual(store.contents().map((entry) => entry.setId), ['set_1', 'set_2']);

  const second = await queue.flush();
  assert.equal(api.calls.length, 2);
  assert.equal(second.pending[0].attempts, 2);
});

// The whole reason the code exists: a queue that read the sentence would drop this set the first
// time somebody reworded the refusal.
test('session-finished is terminal and is SURFACED — never counted as delivered', async () => {
  let now = START;
  const api = apiThat(new GymError(409, 'this session was closed at 18:42', 'session-finished'), {});
  const store = memoryStore();
  const queue = queueOn(api, store, () => now);
  queue.enqueue(entryOf('set_1', START));
  queue.enqueue(entryOf('set_2', START + 60_000));
  now += 9000;

  const report = await queue.flush();
  assert.equal(report.refused.length, 1);
  assert.equal(report.refused[0].entry.setId, 'set_1');
  assert.equal(report.refused[0].reason, 'the session closed before this set reached it');
  assert.equal(report.delivered.length, 1);
  assert.equal(report.delivered[0].entry.setId, 'set_2');
  assert.deepEqual(report.pending, []);
  assert.deepEqual(store.contents(), []);
});

test('a 400 is terminal too — surfaced, dropped, and the queue behind it keeps moving', async () => {
  let now = START;
  const api = apiThat(new GymError(400, 'no such exercise', 'unknown-exercise'), {});
  const queue = queueOn(api, memoryStore(), () => now);
  queue.enqueue(entryOf('set_1', START));
  queue.enqueue(entryOf('set_2', START + 60_000));
  now += 9000;

  const report = await queue.flush();
  assert.deepEqual(report.refused.map((each) => [each.entry.setId, each.reason]), [
    ['set_1', 'that movement is not in the catalog'],
  ]);
  assert.deepEqual(report.delivered.map((each) => each.entry.setId), ['set_2']);
});

// set-id-taken is the one 409 that means "try again": the id names a row outside this session, so
// the set is re-minted and re-sent rather than dropped.
test('set-id-taken mints a fresh id and sends the same set again', async () => {
  let now = START;
  const api = apiThat(new GymError(409, 'that identifier already names a set', 'set-id-taken'), {});
  const queue = queueOn(api, memoryStore(), () => now, () => 'set_fresh');
  queue.enqueue(entryOf('set_1', START));
  now += 9000;

  const report = await queue.flush();
  assert.deepEqual(api.calls.map((call) => call.body.id), ['set_1', 'set_fresh']);
  assert.deepEqual(report.reminted, [{ from: 'set_1', to: 'set_fresh' }]);
  assert.deepEqual(report.delivered.map((each) => each.entry.setId), ['set_fresh']);
  assert.deepEqual(report.refused, []);
});

test('a set-id-taken that never resolves is refused rather than re-minted forever', async () => {
  let now = START;
  const api = apiThat(new GymError(409, 'that identifier already names a set', 'set-id-taken'));
  const queue = queueOn(api, memoryStore(), () => now, () => `set_${Math.random()}`);
  queue.enqueue(entryOf('set_1', START));
  now += 9000;

  const report = await queue.flush();
  assert.equal(api.calls.length, 4);
  assert.equal(report.reminted.length, 3);
  assert.equal(report.refused.length, 1);
  assert.deepEqual(report.pending, []);
});

// FLUSH BEFORE FINISH. Finishing is the client's statement that everything it holds is already
// delivered; the queue is what makes that statement true, or refuses to let it be made.
test('flushBeforeFinish forces the held sets out and answers whether it drained', async () => {
  let now = START;
  const api = apiThat({});
  const queue = queueOn(api, memoryStore(), () => now);
  queue.enqueue(entryOf('set_1', START));
  queue.enqueue(entryOf('set_2', START + 1000));

  const plain = await queue.flush();
  assert.deepEqual(api.calls, []);
  assert.equal(plain.pending.length, 2);

  const { drained, stranded, report } = await queue.flushBeforeFinish('ses_1');
  assert.equal(drained, true);
  assert.deepEqual(stranded, []);
  assert.deepEqual(report.delivered.map((each) => each.entry.setId), ['set_1', 'set_2']);
  assert.deepEqual(queue.pending, []);
});

test('flushBeforeFinish refuses to call a session drained while a retryable set is still held', async () => {
  let now = START;
  const api = apiThat(new GymError(500, 'internal error'));
  const queue = queueOn(api, memoryStore(), () => now);
  queue.enqueue(entryOf('set_1', START));

  const { drained, stranded, report } = await queue.flushBeforeFinish('ses_1');
  assert.equal(drained, false);
  assert.deepEqual(stranded.map((entry) => entry.setId), ['set_1']);
  assert.deepEqual(report.delivered, []);
  assert.deepEqual(report.refused, []);
  assert.deepEqual(report.pending.map((entry) => entry.setId), ['set_1']);
  assert.equal(queue.pending.length, 1);
});

test('the queue is the store — a tab closed mid-session picks its sets back up', async () => {
  let now = START;
  const store = memoryStore();
  const before = queueOn(apiThat({}), store, () => now);
  before.enqueue(entryOf('set_1', START));
  assert.deepEqual(store.contents().map((entry) => entry.setId), ['set_1']);

  now += 9000;
  const api = apiThat({});
  const after = queueOn(api, store, () => now);
  assert.deepEqual(after.pending.map((entry) => entry.setId), ['set_1']);
  await after.flush();
  assert.deepEqual(api.calls.map((call) => call.body.id), ['set_1']);
  assert.deepEqual(store.contents(), []);
});

// A SEND IS NOT AN INSTANT. The lifter's thumb runs while it is in the air — Undo withdraws, the
// next set enqueues — so the queue that comes back is not the queue that went out. Everything
// below is that one second, and every one of them was a real set on a real phone.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function gatedApi() {
  const calls = [];
  const waiting = [];
  let open = false;
  let answer = null;
  return {
    calls,
    release(next = null) {
      open = true;
      answer = next;
      waiting.splice(0).forEach((resolve) => resolve());
    },
    async appendSet(sessionId, body) {
      calls.push(body.id);
      if (!open) await new Promise((resolve) => waiting.push(resolve));
      if (answer instanceof Error) throw answer;
      return { ...body, setNumber: calls.length };
    },
  };
}

test('an Undo mid-flight never costs the set the lifter actually performed', async () => {
  const api = gatedApi();
  const store = memoryStore();
  const queue = new FlushQueue({ api, store, mint: () => 'set_fresh', now: () => START, holdMs: 0 });
  queue.enqueue({ ...entryOf('set_typo', START), reps: 4 });
  const flight = queue.flush();
  await settle();

  assert.equal(queue.withdraw('set_typo'), true);
  queue.enqueue({ ...entryOf('set_real', START + 1000), reps: 5 });
  api.release();
  const report = await flight;

  assert.deepEqual(api.calls, ['set_typo', 'set_real']);
  assert.deepEqual(report.delivered.map((each) => each.entry.setId), ['set_real']);
  assert.deepEqual(report.restored.map((each) => each.entry.setId), ['set_typo']);
  assert.deepEqual(queue.pending, []);
  assert.deepEqual(store.contents(), []);
});

test('a send that fails mid-withdrawal never resurrects the set the lifter took back', async () => {
  const api = gatedApi();
  const store = memoryStore();
  const queue = new FlushQueue({ api, store, mint: () => 'set_fresh', now: () => START, holdMs: 0 });
  queue.enqueue({ ...entryOf('set_typo', START), reps: 8 });
  const flight = queue.flush();
  await settle();

  queue.withdraw('set_typo');
  queue.enqueue({ ...entryOf('set_real', START + 1000), reps: 3 });
  api.release(new GymError(503, 'could not store that set'));
  const report = await flight;

  assert.deepEqual(api.calls, ['set_typo', 'set_real']);
  assert.deepEqual(report.restored, []);
  assert.deepEqual(queue.pending.map((entry) => [entry.setId, entry.reps, entry.attempts]), [['set_real', 3, 1]]);
  assert.deepEqual(store.contents().map((entry) => [entry.setId, entry.reps]), [['set_real', 3]]);
});

// The log is append-only: a set that reached it cannot be taken out again, so the only honest move
// is to hand the row back rather than let the history hold a set the device denies.
test('a set that landed while Undo was taking it back is reported, never silently kept', async () => {
  const api = gatedApi();
  const seen = [];
  const queue = new FlushQueue({
    api, store: memoryStore(), mint: () => 'set_fresh', now: () => START, holdMs: 0, onReport: (report) => seen.push(report),
  });
  queue.enqueue(entryOf('set_1', START));
  const flight = queue.flush();
  await settle();
  queue.withdraw('set_1');
  api.release();
  const report = await flight;

  assert.deepEqual(report.restored.map((each) => [each.entry.setId, each.stored.setNumber]), [['set_1', 1]]);
  assert.deepEqual(report.delivered, []);
  assert.deepEqual(report.refused, []);
  assert.deepEqual(queue.pending, []);
  assert.equal(seen.length, 1);
});

// THE JAM. One 401 mid-workout, or a session that no longer exists, used to stop the walk at the
// head — and everything behind it stopped being sent, stopped counting attempts, and drew as saved.
test('a set that cannot land holds up its own movement and nothing else', async () => {
  const stored = [];
  const api = {
    async appendSet(sessionId, body) {
      if (body.exerciseId === 'back-squat') throw new GymError(401, 'sign in to open your training log');
      stored.push(body.id);
      return { ...body, setNumber: stored.length };
    },
  };
  const queue = new FlushQueue({ api, store: memoryStore(), mint: () => 'set_fresh', now: () => START, holdMs: 0 });
  queue.enqueue({ ...entryOf('set_squat1', START), exerciseId: 'back-squat' });
  queue.enqueue({ ...entryOf('set_bench1', START + 1000), exerciseId: 'bench-press' });
  queue.enqueue({ ...entryOf('set_squat2', START + 2000), exerciseId: 'back-squat' });
  queue.enqueue({ ...entryOf('set_bench2', START + 3000), exerciseId: 'bench-press' });

  const report = await queue.flush();
  assert.deepEqual(stored, ['set_bench1', 'set_bench2']);
  assert.deepEqual(report.delivered.map((each) => each.entry.setId), ['set_bench1', 'set_bench2']);
  assert.deepEqual(report.refused, []);
  assert.deepEqual(report.pending.map((entry) => [entry.setId, entry.attempts]), [['set_squat1', 1], ['set_squat2', 0]]);
});

test('a set stranded against another session never stops this one finishing', async () => {
  const stored = [];
  const api = {
    async appendSet(sessionId, body) {
      if (sessionId === 'ses_gone') throw new GymError(404, 'no such session');
      stored.push(body.id);
      return { ...body, setNumber: stored.length };
    },
  };
  const store = memoryStore();
  const queue = new FlushQueue({ api, store, mint: () => 'set_fresh', now: () => START, holdMs: 9000 });
  queue.enqueue({ ...entryOf('set_stranded', START), sessionId: 'ses_gone' });
  queue.enqueue({ ...entryOf('set_1', START + 1000), sessionId: 'ses_live' });
  queue.enqueue({ ...entryOf('set_2', START + 2000), sessionId: 'ses_live' });

  const { drained, stranded } = await queue.flushBeforeFinish('ses_live');
  assert.equal(drained, true);
  assert.deepEqual(stranded, []);
  assert.deepEqual(stored, ['set_1', 'set_2']);
  assert.deepEqual(queue.pending.map((entry) => entry.setId), ['set_stranded']);
  assert.deepEqual(store.contents().map((entry) => entry.setId), ['set_stranded']);
});

// Finish asked for force and was handed the sweep that was already mid-POST, which breaks at the
// first held entry — so the lifter was told a set was stuck when a forced walk would have sent it.
test('Finish behind a background sweep still forces, and the two walks never overlap', async () => {
  const api = gatedApi();
  let inside = 0;
  let overlapped = false;
  const watched = {
    async appendSet(sessionId, body) {
      inside += 1;
      if (inside > 1) overlapped = true;
      try { return await api.appendSet(sessionId, body); } finally { inside -= 1; }
    },
  };
  let now = START;
  const queue = new FlushQueue({ api: watched, store: memoryStore(), mint: () => 'set_fresh', now: () => now, holdMs: 9000 });
  queue.enqueue(entryOf('set_1', START));
  now += 9000;
  queue.enqueue(entryOf('set_2', now));

  const sweep = queue.flush();
  await settle();
  const finishing = queue.flushBeforeFinish('ses_1');
  api.release();
  await sweep;
  const { drained, stranded } = await finishing;

  assert.equal(overlapped, false);
  assert.equal(drained, true);
  assert.deepEqual(stranded, []);
  assert.deepEqual(api.calls, ['set_1', 'set_2']);
  assert.deepEqual(queue.pending, []);
});

// attempts is the retry counter and remints is the repair budget. Conflated, twelve seconds of no
// signal spent a set's three chances to survive an id collision, and the set was destroyed instead.
test('offline sweeps never spend a set’s repair budget', async () => {
  let sweeps = 3;
  const api = {
    async appendSet(sessionId, body) {
      if (sweeps > 0) { sweeps -= 1; throw new TypeError('Failed to fetch'); }
      if (body.id === 'set_spent') throw new GymError(409, 'that identifier already names a set', 'set-id-taken');
      return { ...body, setNumber: 1 };
    },
  };
  const queue = new FlushQueue({ api, store: memoryStore(), mint: () => 'set_fresh', now: () => START, holdMs: 0 });
  queue.enqueue(entryOf('set_spent', START));
  await queue.flush();
  await queue.flush();
  await queue.flush();
  assert.deepEqual(queue.pending.map((entry) => [entry.attempts, entry.remints]), [[3, 0]]);

  const report = await queue.flush();
  assert.deepEqual(report.reminted, [{ from: 'set_spent', to: 'set_fresh' }]);
  assert.deepEqual(report.delivered.map((each) => each.entry.setId), ['set_fresh']);
  assert.deepEqual(report.refused, []);
});

// Two tabs, one key, and each used to write its whole array over the other's. A tab discarded after
// that — which mobile Safari does eagerly — took the sets whose only durable copy had been erased.
test('two tabs share one key and neither erases the other’s sets', async () => {
  const disk = new Map();
  const storage = {
    getItem: (key) => (disk.has(key) ? disk.get(key) : null),
    setItem: (key, value) => disk.set(key, value),
  };
  const { localStore } = await import('../../../../src/products/gym/logger/flushQueue.js');
  const KEY = 'windmill.gym.queue';
  const api = apiThat({});
  const tabA = new FlushQueue({ api, store: localStore(KEY, storage), now: () => START, holdMs: 0 });
  const tabB = new FlushQueue({ api, store: localStore(KEY, storage), now: () => START, holdMs: 0 });

  tabA.enqueue(entryOf('set_a1', START));
  tabA.enqueue(entryOf('set_a2', START + 1000));
  tabB.enqueue(entryOf('set_b1', START + 2000));
  assert.deepEqual(JSON.parse(storage.getItem(KEY)).map((entry) => entry.setId), ['set_a1', 'set_a2', 'set_b1']);

  // Tab A cannot reach the log, and its retry must not write its own two sets over tab B's third.
  const offline = new FlushQueue({
    api: apiThat(new TypeError('Failed to fetch')), store: localStore(KEY, storage), now: () => START, holdMs: 0,
  });
  await offline.flush();
  assert.deepEqual(JSON.parse(storage.getItem(KEY)).map((entry) => entry.setId), ['set_a1', 'set_a2', 'set_b1']);

  // The signal comes back to tab A. It adopts the set tab B never got out, and B's set lands too.
  await tabA.flush();
  assert.deepEqual(api.calls.map((call) => call.body.id), ['set_a1', 'set_a2', 'set_b1']);
  assert.deepEqual(JSON.parse(storage.getItem(KEY)), []);

  const afterTabBIsDiscarded = new FlushQueue({ api, store: localStore(KEY, storage), now: () => START, holdMs: 0 });
  assert.deepEqual(afterTabBIsDiscarded.pending, []);
});

// The hold is the device's promise, not the queue's: it costs nothing while the store is holding
// the set. A store that refused the bytes is holding nothing, and the network is the only copy left.
test('a store that refuses the write is not durable, and the undo hold goes with it', async () => {
  const api = apiThat({});
  const store = memoryStore();
  store.refuse();
  const queue = new FlushQueue({ api, store, mint: () => 'set_fresh', now: () => START, holdMs: 9000 });
  queue.enqueue(entryOf('set_1', START));

  assert.equal(queue.durable, false);
  assert.deepEqual(store.contents(), []);
  const report = await queue.flush();
  assert.deepEqual(api.calls.map((call) => call.body.id), ['set_1']);
  assert.deepEqual(report.delivered.map((each) => each.entry.setId), ['set_1']);
  assert.deepEqual(queue.pending, []);
});

test('a store that takes the bytes keeps the hold — the 9 s window is not spent on durability', async () => {
  const api = apiThat({});
  const queue = new FlushQueue({ api, store: memoryStore(), mint: () => 'set_fresh', now: () => START, holdMs: 9000 });
  queue.enqueue(entryOf('set_1', START));

  assert.equal(queue.durable, true);
  await queue.flush();
  assert.deepEqual(api.calls, []);
  assert.deepEqual(queue.pending.map((entry) => entry.setId), ['set_1']);
});

test('a report reaches the surface exactly once per flush, whoever asked for it', async () => {
  let now = START;
  const seen = [];
  const queue = new FlushQueue({
    api: apiThat({}),
    store: memoryStore(),
    mint: () => 'set_fresh',
    now: () => now,
    holdMs: 9000,
    onReport: (report) => seen.push(report),
  });
  queue.enqueue(entryOf('set_1', START));
  now += 9000;
  const returned = await queue.flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0], returned);
});
