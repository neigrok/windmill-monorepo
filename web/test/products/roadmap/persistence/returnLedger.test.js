import test from 'node:test';
import assert from 'node:assert/strict';

import { ReturnLedger } from '../../../../src/products/roadmap/persistence/ReturnLedger.js';

// A statesMap carrying every id the current tree still holds — `since` filters against it.
function statesOf(entries) {
  return new Map(entries);
}

test('since — a first-ever visit (no prior ledger) replays nothing', () => {
  const completed = new Set(['a', 'b']);
  const states = statesOf([['a', 'complete'], ['b', 'complete']]);
  assert.deepEqual(ReturnLedger.since(completed, null, states), []);
});

test('since — returns exactly the ids completed since the prior ledger, in completed order', () => {
  const completed = new Set(['a', 'b', 'c']);
  const prior = { completed: ['a'], at: 10 };
  const states = statesOf([['a', 'complete'], ['b', 'complete'], ['c', 'complete'], ['d', 'available']]);
  assert.deepEqual(ReturnLedger.since(completed, prior, states), ['b', 'c']);
});

test('since — a completion from another device (absent from prior, no local timestamp) is included', () => {
  const completed = new Set(['a', 'x']);
  const prior = { completed: ['a'], at: 100 }; // x was completed elsewhere; the prior slot never saw it
  const states = statesOf([['a', 'complete'], ['x', 'complete']]);
  assert.deepEqual(ReturnLedger.since(completed, prior, states), ['x']);
});

test('since — ids complete at the prior visit and still complete are excluded', () => {
  const completed = new Set(['a', 'b']);
  const prior = { completed: ['a', 'b'], at: 5 };
  const states = statesOf([['a', 'complete'], ['b', 'complete']]);
  assert.deepEqual(ReturnLedger.since(completed, prior, states), []);
});

test('since — an id completed at the prior visit but since undone is not replayed (no regression)', () => {
  const completed = new Set(['a']); // b was undone — it is no longer complete
  const prior = { completed: ['a', 'b'], at: 5 };
  const states = statesOf([['a', 'complete'], ['b', 'available']]);
  assert.deepEqual(ReturnLedger.since(completed, prior, states), []);
});

test('since — a step completed live this session is not replayed on a same-session reload', () => {
  const completed = new Set(['a', 'b']);
  const prior = { completed: ['a', 'b'], at: 999 }; // baseline advanced the moment b was completed
  const states = statesOf([['a', 'complete'], ['b', 'complete']]);
  assert.deepEqual(ReturnLedger.since(completed, prior, states), []);
});

test('since — a completed id whose node no longer exists in the tree is not replayed', () => {
  const completed = new Set(['a', 'gone']);
  const prior = { completed: ['a'], at: 1 };
  const states = statesOf([['a', 'complete']]); // 'gone' was deleted — absent from the current tree
  assert.deepEqual(ReturnLedger.since(completed, prior, states), []);
});

test('load / save / clear — a round-trip through storage returns the stored slot, clear removes it', () => {
  const backing = new Map();
  const storage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, value),
    removeItem: (key) => backing.delete(key),
  };
  const ledger = new ReturnLedger(storage);

  assert.equal(ledger.load('t_1'), null);
  ledger.save('t_1', { completed: new Set(['a', 'b']), at: 42 });
  assert.deepEqual(ledger.load('t_1'), { completed: ['a', 'b'], at: 42 });
  ledger.clear('t_1');
  assert.equal(ledger.load('t_1'), null);
});
