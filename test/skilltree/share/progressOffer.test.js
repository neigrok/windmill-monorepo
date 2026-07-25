// The recurring offer's rules (brief #20). A repeat offer earns its place only if it can't turn
// into nagging, so every gate is pinned here — including the one that makes the shape work: the
// three-day budget burns in commit(), not in the decision, so an offer that never fires is free.

import test from 'node:test';
import assert from 'node:assert/strict';

import { considerProgressShare } from '../../../src/skilltree/share/progressOffer.js';
import { ShareLedger } from '../../../src/skilltree/persistence/ShareLedger.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function fakeStorage() {
  const backing = new Map();
  return {
    backing,
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, value),
    removeItem: (key) => backing.delete(key),
  };
}

// A tree shared `agoDays` ago carrying `sharedIds`, now complete on `completedIds`.
function scenario({ sharedIds = [], agoDays = 1, count = 1, completedIds = [], extraStates = [], shared = true } = {}) {
  const storage = fakeStorage();
  if (shared) new ShareLedger(storage).save('t_1', { completed: sharedIds, at: NOW - agoDays * DAY, count });
  const states = new Map([...completedIds.map((id) => [id, 'complete']), ...extraStates]);
  return { storage, args: { treeId: 't_1', completed: new Set(completedIds), states, now: NOW, storage } };
}

test('a tree never shared is never offered — the first share is not a "since" card', () => {
  const { args } = scenario({ shared: false, completedIds: ['a', 'b', 'c', 'd'] });
  assert.deepEqual(considerProgressShare(args), { offer: false });
});

test('nothing new since the last share is never offered', () => {
  const { args } = scenario({ sharedIds: ['a', 'b'], completedIds: ['a', 'b'] });
  assert.deepEqual(considerProgressShare(args), { offer: false });
});

test('three newly-lit steps earn the offer, carrying the ids and the next ordinal', () => {
  const { args } = scenario({ sharedIds: ['a'], count: 3, completedIds: ['a', 'b', 'c', 'd'] });
  const decision = considerProgressShare(args);

  assert.equal(decision.offer, true);
  assert.deepEqual(decision.lit, ['b', 'c', 'd']);
  assert.equal(decision.update, 4);
});

test('two newly-lit steps on a fresh share is not yet a post', () => {
  const { args } = scenario({ sharedIds: ['a'], completedIds: ['a', 'b', 'c'] });
  assert.deepEqual(considerProgressShare(args), { offer: false });
});

test('a week since the last share lowers the bar to a single step', () => {
  const stale = scenario({ sharedIds: ['a'], agoDays: 8, completedIds: ['a', 'b'] });
  assert.equal(considerProgressShare(stale.args).offer, true);

  const fresh = scenario({ sharedIds: ['a'], agoDays: 6, completedIds: ['a', 'b'] });
  assert.deepEqual(considerProgressShare(fresh.args), { offer: false });
});

test('a step whose node was deleted can never be the thing that earns an offer', () => {
  const { args } = scenario({ sharedIds: ['a'], completedIds: ['a', 'b', 'c', 'gone'] });
  args.states.delete('gone');
  assert.deepEqual(considerProgressShare(args), { offer: false }); // only b and c remain — under the bar
});

test('commit() burns the budget: no second ask for three days', () => {
  const { storage, args } = scenario({ sharedIds: ['a'], count: 1, completedIds: ['a', 'b', 'c', 'd'] });
  considerProgressShare(args).commit();

  assert.deepEqual(considerProgressShare({ ...args, now: NOW + DAY }), { offer: false });
  assert.deepEqual(considerProgressShare({ ...args, now: NOW + 3 * DAY - 1 }), { offer: false });
  assert.equal(considerProgressShare({ ...args, now: NOW + 3 * DAY, storage }).offer, true);
});

test('an offer that never fires costs nothing — not committing leaves it available', () => {
  const { args } = scenario({ sharedIds: ['a'], completedIds: ['a', 'b', 'c', 'd'] });

  assert.equal(considerProgressShare(args).offer, true); // decided, declined at fire time, uncommitted
  assert.equal(considerProgressShare(args).offer, true);
  assert.equal(considerProgressShare({ ...args, now: NOW + 60_000 }).offer, true);
});

test('storage that refuses reads as "never shared" and commits without throwing', () => {
  const hostile = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => { throw new Error('denied'); },
  };
  const args = { treeId: 't_1', completed: new Set(['a']), states: new Map([['a', 'complete']]), now: NOW, storage: hostile };
  assert.deepEqual(considerProgressShare(args), { offer: false });
});
