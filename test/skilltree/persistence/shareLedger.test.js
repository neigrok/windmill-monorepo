import test from 'node:test';
import assert from 'node:assert/strict';

import { ShareLedger } from '../../../src/skilltree/persistence/ShareLedger.js';

function fakeStorage(entries = []) {
  const backing = new Map(entries);
  return {
    backing,
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, value),
    removeItem: (key) => backing.delete(key),
  };
}

function statesOf(entries) {
  return new Map(entries);
}

test('load / save / clear — a round-trip keeps the completed set, the moment and the ordinal', () => {
  const ledger = new ShareLedger(fakeStorage());

  assert.equal(ledger.load('t_1'), null);
  ledger.save('t_1', { completed: new Set(['a', 'b']), at: 42, count: 1 });
  assert.deepEqual(ledger.load('t_1'), { completed: ['a', 'b'], at: 42, count: 1 });
  ledger.save('t_1', { completed: ['a', 'b', 'c'], at: 99, count: 2 });
  assert.deepEqual(ledger.load('t_1'), { completed: ['a', 'b', 'c'], at: 99, count: 2 });
  ledger.clear('t_1');
  assert.equal(ledger.load('t_1'), null);
});

test('the slot is per tree — one tree’s share history never answers for another', () => {
  const storage = fakeStorage();
  const ledger = new ShareLedger(storage);
  ledger.save('t_1', { completed: ['a'], at: 1, count: 1 });

  assert.equal(ledger.load('t_2'), null);
  assert.deepEqual([...storage.backing.keys()], ['windmill:shared:t_1']);
});

test('since — a tree never shared returns nothing: the first share is not a diff', () => {
  const states = statesOf([['a', 'complete'], ['b', 'complete']]);
  assert.deepEqual(ShareLedger.since(new Set(['a', 'b']), null, states), []);
});

test('since — exactly the ids complete now that the last share did not carry', () => {
  const prior = { completed: ['a'], at: 10, count: 1 };
  const states = statesOf([['a', 'complete'], ['b', 'complete'], ['c', 'complete'], ['d', 'available']]);
  assert.deepEqual(ShareLedger.since(new Set(['a', 'b', 'c']), prior, states), ['b', 'c']);
});

test('since — work done on another device counts: no local timestamp is ever consulted', () => {
  const prior = { completed: ['a'], at: 100, count: 3 };
  const states = statesOf([['a', 'complete'], ['x', 'complete']]);
  assert.deepEqual(ShareLedger.since(new Set(['a', 'x']), prior, states), ['x']);
});

test('since — the baseline survives your own completions, unlike the return ledger', () => {
  // The whole reason this file exists: finishing steps yourself does not re-baseline the share
  // slot, so a fortnightly poster still has a truthful "since you last shared" to point at.
  const prior = { completed: ['a'], at: 1, count: 1 };
  const states = statesOf([['a', 'complete'], ['b', 'complete'], ['c', 'complete']]);
  assert.deepEqual(ShareLedger.since(new Set(['a', 'b', 'c']), prior, states), ['b', 'c']);
});

test('since — an id shared before and since undone is not counted as new', () => {
  const prior = { completed: ['a', 'b'], at: 5, count: 2 };
  const states = statesOf([['a', 'complete'], ['b', 'available']]);
  assert.deepEqual(ShareLedger.since(new Set(['a']), prior, states), []);
});

test('since — a completed id whose node was since deleted never appears on the card', () => {
  const prior = { completed: ['a'], at: 1, count: 1 };
  const states = statesOf([['a', 'complete']]); // 'gone' was deleted out of the tree
  assert.deepEqual(ShareLedger.since(new Set(['a', 'gone']), prior, states), []);
});

test('storage that refuses degrades to "never shared" rather than throwing', () => {
  const hostile = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => { throw new Error('denied'); },
  };
  const ledger = new ShareLedger(hostile);

  assert.equal(ledger.load('t_1'), null);
  assert.doesNotThrow(() => ledger.save('t_1', { completed: ['a'], at: 1, count: 1 }));
  assert.doesNotThrow(() => ledger.clear('t_1'));
});

test('a corrupt slot reads as "never shared" instead of poisoning the diff', () => {
  const ledger = new ShareLedger(fakeStorage([['windmill:shared:t_1', '{not json']]));
  assert.equal(ledger.load('t_1'), null);
});
