import test from 'node:test';
import assert from 'node:assert/strict';

import { ProgressLattice } from '../../../../src/products/roadmap/sync/progressLattice.js';
import { HlcClock, VersionVector, parseHlc } from '../../../../src/products/roadmap/sync/lattice.js';
import { ProgressStore } from '../../../../src/products/roadmap/persistence/ProgressStore.js';

const stamp = (ms, actor = 'r_a') => ({ ms, counter: 0, actor });
const frame = (...rows) => ({ marks: rows });
const row = (node, status, at, markedAt) => (markedAt === undefined
  ? { node, status, at }
  : { node, status, at, markedAt });

test('a later stamp wins and brings its own receipt instant', () => {
  const lattice = new ProgressLattice();

  lattice.join(frame(row('a', 'active', '500:0:r_phone', 1000)));
  lattice.join(frame(row('a', 'complete', '900:0:r_desk', 2000)));

  assert.deepEqual(lattice.overlay(), {
    completed: new Set(['a']),
    inProgress: new Set(),
    startedAt: {},
    completedAt: { a: 2000 },
  });
});

test('an older stamp arriving late changes nothing — not the status, not the date', () => {
  const lattice = new ProgressLattice();
  lattice.join(frame(row('a', 'complete', '900:0:r_desk', 2000)));

  lattice.join(frame(row('a', 'none', '500:0:r_phone', 9999)));

  assert.deepEqual(lattice.overlay(), {
    completed: new Set(['a']),
    inProgress: new Set(),
    startedAt: {},
    completedAt: { a: 2000 },
  });
});

test('a clear is a value, so a step cleared elsewhere stays cleared instead of resurrecting', () => {
  const lattice = new ProgressLattice();
  lattice.join(frame(row('a', 'complete', '500:0:r_here', 1000)));

  lattice.join(frame(row('a', 'none', '900:0:r_phone', 2000)));

  assert.deepEqual(lattice.overlay(), {
    completed: new Set(),
    inProgress: new Set(),
    startedAt: {},
    completedAt: {},
  });
});

test('joining the same frame twice is the same lattice — a replayed echo is not a second mark', () => {
  const lattice = new ProgressLattice();
  const echo = frame(row('a', 'complete', '900:0:r_desk', 2000));

  lattice.join(echo);
  const once = lattice.toFrame();
  lattice.join(echo);

  assert.deepEqual(lattice.toFrame(), once);
});

test('two replicas that see the same frames in opposite orders agree', () => {
  const first = frame(row('a', 'active', '500:0:r_phone', 1000), row('b', 'complete', '600:0:r_phone', 1100));
  const second = frame(row('a', 'complete', '900:0:r_desk', 2000), row('c', 'none', '400:0:r_desk', 900));

  const forward = new ProgressLattice();
  forward.join(first);
  forward.join(second);
  const backward = new ProgressLattice();
  backward.join(second);
  backward.join(first);

  assert.deepEqual(backward.toFrame(), forward.toFrame());
});

test('the outbox is what the coverage does not account for — no queue is kept', () => {
  const lattice = new ProgressLattice();
  lattice.join(frame(row('known', 'complete', '500:0:r_server', 1000), row('offline', 'complete', '900:0:r_me', 2000)));
  const acked = new VersionVector();
  acked.observe(parseHlc('500:0:r_server'));

  assert.deepEqual(lattice.deltaSince(acked), {
    marks: [{ node: 'offline', status: 'complete', at: '900:0:r_me' }],
  });
});

test('the outbox never asserts a receipt instant back upward — that is the server\'s to state', () => {
  const lattice = new ProgressLattice();
  lattice.join(frame(row('a', 'complete', '900:0:r_me', 2000)));

  const [mark] = lattice.deltaSince(new VersionVector()).marks;

  assert.deepEqual(mark, { node: 'a', status: 'complete', at: '900:0:r_me' });
});

test('a local mark is dated by this device until the server echo replaces the instant', () => {
  const lattice = new ProgressLattice();
  const clock = new HlcClock('r_me');

  lattice.mark('a', 'complete', clock.tick(1000), 1000);
  assert.deepEqual(lattice.overlay().completedAt, { a: 1000 });

  lattice.join(frame(row('a', 'complete', '2000:0:r_me', 1234)));
  assert.deepEqual(lattice.overlay().completedAt, { a: 1234 });
});

test('a local mark that loses to a stamp already held is not sent', () => {
  const lattice = new ProgressLattice();
  lattice.join(frame(row('a', 'complete', '900:0:r_desk', 2000)));

  assert.equal(lattice.mark('a', 'none', parseHlc('500:0:r_me'), 500), null);
  assert.deepEqual(lattice.overlay().completed, new Set(['a']));
});

test('one register answers both dates — active is when it started, complete is when it finished', () => {
  const lattice = new ProgressLattice();

  lattice.join(frame(row('running', 'active', '500:0:r_a', 1000), row('done', 'complete', '600:0:r_a', 1100)));

  assert.deepEqual(lattice.overlay(), {
    completed: new Set(['done']),
    inProgress: new Set(['running']),
    startedAt: { running: 1000 },
    completedAt: { done: 1100 },
  });
});

test('a register the server has not dated stays undated rather than guessing', () => {
  const lattice = new ProgressLattice();

  lattice.join(frame(row('a', 'complete', '900:0:r_elsewhere')));

  assert.deepEqual(lattice.overlay().completedAt, {});
  assert.deepEqual(lattice.overlay().completed, new Set(['a']));
});

test('the stored blob carries the receipt instants back, unlike the wire delta', () => {
  const lattice = new ProgressLattice();
  lattice.join(frame(row('a', 'complete', '900:0:r_a', 2000)));

  const reloaded = new ProgressLattice();
  reloaded.join(lattice.toFrame());

  assert.deepEqual(reloaded.overlay().completedAt, { a: 2000 });
});

test('a malformed frame leaves the replica untouched, so the caller can treat it as a gap', () => {
  const lattice = new ProgressLattice();
  lattice.join(frame(row('a', 'complete', '900:0:r_a', 2000)));
  const before = lattice.toFrame();

  assert.throws(() => lattice.join(frame(row('b', 'complete', '950:0:r_a', 1), { node: 'c', status: 'finished', at: '960:0:r_a' })), /unknown progress status/);
  assert.throws(() => lattice.join(frame({ status: 'complete', at: '970:0:r_a' })), /malformed progress mark/);

  assert.deepEqual(lattice.toFrame(), before);
});

test('the clock is seeded past every stamp held, so the next mark dominates them', () => {
  const lattice = new ProgressLattice();
  lattice.join(frame(row('a', 'complete', '9000:0:r_elsewhere', 1)));
  const clock = new HlcClock('r_me');

  lattice.seedClock(clock);

  assert.equal(clock.tick(1000).ms, 9000); // not the wall clock's 1000 — a mark must not tie backwards
});

test('an echo of our own mark replaces the provisional instant with the server\'s', () => {
  const lattice = new ProgressLattice();
  const clock = new HlcClock('r_me');
  const at = clock.tick(5000);

  lattice.mark('a', 'complete', at, 5000);          // this device's guess
  lattice.join(frame(row('a', 'complete', `${at.ms}:0:r_me`, 4321)));  // the server's receipt

  assert.deepEqual(lattice.overlay().completedAt, { a: 4321 });
});

test('an equal-stamp frame with no instant leaves the one already held alone', () => {
  const lattice = new ProgressLattice();
  lattice.join(frame(row('a', 'complete', '900:0:r_a', 4321)));

  lattice.join(frame(row('a', 'complete', '900:0:r_a')));

  assert.deepEqual(lattice.overlay().completedAt, { a: 4321 });
});

test('draining the pre-lane store lands its marks in the lane and clears the key', () => {
  const storage = new Map();
  storage.set('windmill:progress:t_1', JSON.stringify({
    completed: ['done', 'undated'],
    inProgress: ['running'],
    completedAt: { done: 5000 },
    startedAt: { running: 6000 },
  }));
  const store = new ProgressStore({
    getItem: (k) => storage.get(k) ?? null,
    removeItem: (k) => storage.delete(k),
  });
  const lattice = new ProgressLattice();

  assert.equal(store.drainInto('t_1', lattice), 3);

  assert.deepEqual(lattice.overlay(), {
    completed: new Set(['done', 'undated']),
    inProgress: new Set(['running']),
    startedAt: {},     // a drained mark has no SERVER receipt yet, so it is undated, not guessed
    completedAt: {},
  });
  assert.equal(storage.has('windmill:progress:t_1'), false);
  assert.equal(store.drainInto('t_1', lattice), 0); // …and draining twice is not a second import
});

test('a drained mark loses to a newer server mark and wins where nothing contests it', () => {
  const storage = new Map();
  storage.set('windmill:progress:t_1', JSON.stringify({
    completed: ['superseded', 'only-here'],
    inProgress: [],
    completedAt: { superseded: 5000, 'only-here': 5000 },
  }));
  const store = new ProgressStore({
    getItem: (k) => storage.get(k) ?? null,
    removeItem: (k) => storage.delete(k),
  });
  const lattice = new ProgressLattice();
  lattice.join(frame(row('superseded', 'none', '9000:0:r_phone', 9000))); // cleared later, elsewhere

  store.drainInto('t_1', lattice);

  assert.deepEqual(lattice.overlay().completed, new Set(['only-here']));
});
