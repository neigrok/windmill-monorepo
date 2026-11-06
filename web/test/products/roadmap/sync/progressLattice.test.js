import test from 'node:test';
import assert from 'node:assert/strict';

import { ProgressLattice } from '../../../../src/products/roadmap/sync/progressLattice.js';
import { HlcClock, parseHlc } from '../../../../src/products/roadmap/sync/lattice.js';
import { outboxWrites } from '../../../../src/products/roadmap/sync/pendingWrites.js';
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
    completedAt: { a: 2000 },
  });
});

test('an older stamp arriving late changes nothing — not the status, not the date', () => {
  const lattice = new ProgressLattice();
  lattice.join(frame(row('a', 'complete', '900:0:r_desk', 2000)));

  lattice.join(frame(row('a', 'none', '500:0:r_phone', 9999)));

  assert.deepEqual(lattice.overlay(), {
    completed: new Set(['a']),
    completedAt: { a: 2000 },
  });
});

test('a clear is a value, so a step cleared elsewhere stays cleared instead of resurrecting', () => {
  const lattice = new ProgressLattice();
  lattice.join(frame(row('a', 'complete', '500:0:r_here', 1000)));

  lattice.join(frame(row('a', 'none', '900:0:r_phone', 2000)));

  assert.deepEqual(lattice.overlay(), {
    completed: new Set(),
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

test('the outbox retains marks absent from the confirmed baseline', () => {
  const lattice = new ProgressLattice();
  lattice.join(frame(row('known', 'complete', '500:0:r_server', 1000), row('offline', 'complete', '900:0:r_me', 2000)));
  const confirmed = frame(row('known', 'complete', '500:0:r_server', 1000));

  assert.deepEqual(outboxWrites(lattice.toFrame(), confirmed), {
    marks: [{ node: 'offline', status: 'complete', at: '900:0:r_me', markedAt: 2000 }],
  });
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

test('legacy active marks become not started while completed dates remain intact', () => {
  const lattice = new ProgressLattice();

  lattice.join(frame(row('running', 'active', '500:0:r_a', 1000), row('done', 'complete', '600:0:r_a', 1100)));

  assert.deepEqual(lattice.overlay(), {
    completed: new Set(['done']),
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

test('malformed progress rows leave valid rows before and after them intact', () => {
  const lattice = new ProgressLattice();
  const skipped = [];
  const marks = [
    row('a', 'complete', '900:0:r_a', 2000),
    { node: 'invalid-status', status: 'finished', at: '960:0:r_a' },
    row('b', 'none', '950:0:r_a', 2001),
    { status: 'complete', at: '970:0:r_a' },
    row('c', 'complete', '980:0:r_a', 2002),
  ];
  assert.doesNotThrow(() => lattice.join({ marks }, (...args) => skipped.push(args)));
  assert.deepEqual(lattice.toFrame(), { marks: [marks[0], marks[2], marks[4]] });
  assert.deepEqual(skipped, [[], []]);
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
    inProgress: ['running', 'done'],
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

test('legacy progress aliases serialize and replay as none, including the offline outbox', () => {
  const lattice = new ProgressLattice();
  lattice.join({ marks: [
    { node: 'done', status: 'complete', at: '600:0:r_a', markedAt: 1100 },
    { node: 'old-active', status: 'active', at: '500:0:r_a', markedAt: 1000 },
    { node: 'old-inProgress', status: 'inProgress', at: '550:0:r_a', markedAt: 1050 },
  ] });
  const copy = new ProgressLattice();
  copy.join(lattice.toFrame());

  assert.deepEqual(copy.overlay(), { completed: new Set(['done']), completedAt: { done: 1100 } });
  assert.deepEqual(outboxWrites(copy.toFrame(), {}), { marks: [
    { node: 'done', status: 'complete', at: '600:0:r_a', markedAt: 1100 },
    { node: 'old-active', status: 'none', at: '500:0:r_a', markedAt: 1000 },
    { node: 'old-inProgress', status: 'none', at: '550:0:r_a', markedAt: 1050 },
  ] });
  assert.throws(() => copy.mark('old-active', 'active', parseHlc('900:0:r_a'), 900), /unknown progress status/);
  assert.throws(() => copy.mark('old-inProgress', 'inProgress', parseHlc('950:0:r_a'), 950), /unknown progress status/);
});

test('an Undo of Reset is a fresh mark: the step completes at the Undo’s time and heads Done', async () => {
  const { SkillTree } = await import('../../../../src/products/roadmap/model/SkillTree.js');
  const { Board } = await import('../../../../src/products/roadmap/board/Board.js');
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: 'course', label: 'Choose a sailing course', prerequisites: [] },
    { id: 'parts', label: 'Name the boat parts', prerequisites: ['course'] },
    { id: 'rig', label: 'Rig the boat', prerequisites: ['parts'] },
  ] });
  const lattice = new ProgressLattice();
  lattice.mark('course', 'complete', stamp(100), 100);
  lattice.mark('parts', 'complete', stamp(200), 200);
  lattice.mark('rig', 'complete', stamp(300), 300);
  const doneOrder = () => new Board(tree, lattice.overlay()).done.cards.map((card) => card.id);
  assert.deepEqual(doneOrder(), ['rig', 'parts', 'course']);

  lattice.mark('parts', 'none', stamp(400), 400);
  lattice.mark('parts', 'complete', stamp(500), 500);
  assert.deepEqual([doneOrder(), lattice.overlay().completedAt.parts], [['parts', 'rig', 'course'], 500]);
});

for (const at of [undefined, null, '', 'not-a-stamp', '0:0:', 'NaN:0:r_a', '1:NaN:r_a', 42,
  '01:0:r_a', '1:00:r_a', '-1:0:r_a', '1:-1:r_a', '1.5:0:r_a', '1:1.5:r_a',
  '9007199254740992:0:r_a', '1:4294967296:r_a', '1:0:', `1:0:${'a'.repeat(65)}`, '1:0:with\nline', '1:0:☀']) {
  test(`an invalid progress stamp ${JSON.stringify(at)} is skipped while valid marks still join`, () => {
    const lattice = new ProgressLattice();
    lattice.join({ marks: [{ node: 'held', status: 'complete', at: '5:0:r_a', markedAt: 5 }] });
    const skipped = [];
    assert.doesNotThrow(() => lattice.join({ marks: [
      { node: 'valid-first', status: 'complete', at: '6:0:r_a', markedAt: 6 },
      { node: 'invalid', status: 'complete', at },
      { node: 'valid-last', status: 'none', at: '7:0:r_a', markedAt: 7 },
    ] }, (...args) => skipped.push(args)));
    assert.deepEqual(lattice.toFrame(), { marks: [
      { node: 'held', status: 'complete', at: '5:0:r_a', markedAt: 5 },
      { node: 'valid-first', status: 'complete', at: '6:0:r_a', markedAt: 6 },
      { node: 'valid-last', status: 'none', at: '7:0:r_a', markedAt: 7 },
    ] });
    assert.deepEqual(skipped, [[]]);
  });
}

for (const at of ['0:0:r_a', '1:0:with space', '9007199254740991:4294967295:r:colon', `1:0:${'a'.repeat(64)}`]) {
  test(`a valid boundary progress stamp ${at} round trips unchanged`, () => {
    const lattice = new ProgressLattice();
    const frame = { marks: [{ node: 'root', status: 'complete', at }] };
    lattice.join(frame);
    assert.deepEqual(lattice.toFrame(), frame);
  });
}

test('a legacy drain skips an invalid mark, reports it and moves every valid mark before clearing the key', () => {
  const storage = new Map([['windmill:progress:t_1', JSON.stringify({
    completed: ['a', 'invalid-private-id', 'b'], completedAt: { a: 5, 'invalid-private-id': 'not-an-instant', b: 6 },
  })]]);
  const reports = [];
  const store = new ProgressStore({
    getItem: (key) => storage.get(key) ?? null,
    removeItem: (key) => storage.delete(key),
  }, { reportFailure: (operation, error, tags) => reports.push({ operation, error, tags }) });
  const lattice = new ProgressLattice();
  assert.equal(store.drainInto('t_1', lattice), 2);
  assert.deepEqual(lattice.toFrame(), { marks: [
    { node: 'a', status: 'complete', at: '5:0:legacy' },
    { node: 'b', status: 'complete', at: '6:0:legacy' },
  ] });
  assert.equal(storage.has('windmill:progress:t_1'), false);
  assert.deepEqual(reports.map(({ operation, error, tags }) => ({ operation, message: error.message, stack: !!error.stack, tags })),
    [{ operation: 'roadmap-sync-progress-mark', message: 'Roadmap progress mark invalid', stack: true, tags: { lane: 'progress' } }]);
  assert.equal(store.drainInto('t_1', lattice), 0);
});

test('a malformed progress marks container reports once and preserves the existing valid bank', () => {
  const lattice = new ProgressLattice();
  const before = { marks: [{ node: 'held', status: 'complete', at: '5:0:r_a' }] };
  lattice.join(before);
  const skipped = [];
  assert.doesNotThrow(() => lattice.join({ marks: 'private-invalid-container' }, (...args) => skipped.push(args)));
  assert.deepEqual(lattice.toFrame(), before);
  assert.deepEqual(skipped, [[]]);
});
