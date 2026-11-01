import test from 'node:test';
import assert from 'node:assert/strict';

import { boardOpen } from '../../../../src/products/roadmap/board/gate.js';

function storageWith(entries) {
  const map = new Map(Object.entries(entries));
  return { getItem: (key) => (map.has(key) ? map.get(key) : null) };
}

test('boardOpen — off production the dev opt-in "1" opens the Board, and nothing else does', () => {
  assert.equal(boardOpen({ production: false, storage: storageWith({ 'windmill:board:dev': '1' }) }), true);
  assert.equal(boardOpen({ production: false, storage: storageWith({ 'windmill:board:dev': 'true' }) }), false);
  assert.equal(boardOpen({ production: false, storage: storageWith({}) }), false);
  assert.equal(boardOpen({ production: false, storage: undefined }), false);
});

test('boardOpen — production keeps the Board closed whatever the device says', () => {
  assert.equal(boardOpen({ production: true, storage: storageWith({ 'windmill:board:dev': '1' }) }), false);
});

test('boardOpen — a storage that throws reads as closed', () => {
  const blocked = { getItem: () => { throw new Error('blocked'); } };
  assert.equal(boardOpen({ production: false, storage: blocked }), false);
});

test('boardOpen — under node, with no build flags and no storage, the Board is closed', () => {
  assert.equal(boardOpen(), false);
});
