import test from 'node:test';
import assert from 'node:assert/strict';

import { boardOpen } from '../../../../src/products/roadmap/board/gate.js';

function storageWith(entries) {
  const map = new Map(Object.entries(entries));
  return { getItem: (key) => (map.has(key) ? map.get(key) : null) };
}

test('boardOpen — only the device opt-in "1" opens the Board in every build', () => {
  assert.equal(boardOpen({ storage: storageWith({ 'windmill:board:dev': '1' }) }), true);
  assert.equal(boardOpen({ storage: storageWith({ 'windmill:board:dev': 'true' }) }), false);
  assert.equal(boardOpen({ storage: storageWith({}) }), false);
  assert.equal(boardOpen({ storage: null }), false);
});

test('boardOpen — a storage that throws reads as closed', () => {
  const blocked = { getItem: () => { throw new Error('blocked'); } };
  assert.equal(boardOpen({ storage: blocked }), false);
});

test('boardOpen — without device storage, the Board is closed', () => {
  assert.equal(boardOpen(), false);
});

test('boardOpen fails closed when obtaining localStorage itself throws', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  });
  assert.equal(boardOpen(), false);
});
