import test from 'node:test';
import assert from 'node:assert/strict';

import { ViewPrefs, initialView, stampBorn, peekBorn, clearBorn } from '../../../src/skilltree/persistence/ViewPrefs.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

function throwingStorage() {
  return {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
}

test('ViewPrefs — last view round-trips per tree and defaults to null', () => {
  const prefs = new ViewPrefs(memoryStorage());
  assert.equal(prefs.lastView('t1'), null);

  prefs.setLastView('t1', 'list');
  prefs.setLastView('t2', 'tree');
  assert.equal(prefs.lastView('t1'), 'list');
  assert.equal(prefs.lastView('t2'), 'tree');
  assert.equal(prefs.lastView('t3'), null);
});

test('ViewPrefs — folded sections round-trip per tree and default to empty', () => {
  const prefs = new ViewPrefs(memoryStorage());
  assert.deepEqual(prefs.foldedSections('t1'), []);

  prefs.setFoldedSections('t1', ['a', 'b']);
  prefs.setFoldedSections('t2', ['c']);
  assert.deepEqual(prefs.foldedSections('t1'), ['a', 'b']);
  assert.deepEqual(prefs.foldedSections('t2'), ['c']);
  assert.deepEqual(prefs.foldedSections('t3'), []);
});

test('ViewPrefs — the card counts weeks until a tree is told otherwise, and remembers per tree', () => {
  const prefs = new ViewPrefs(memoryStorage());
  assert.equal(prefs.cardUnit('t1'), 'week');

  prefs.setCardUnit('t1', 'day');
  assert.equal(prefs.cardUnit('t1'), 'day');
  assert.equal(prefs.cardUnit('t2'), 'week');

  prefs.setCardUnit('t1', 'fortnight'); // an unknown unit is weeks — the card never prints a guess
  assert.equal(prefs.cardUnit('t1'), 'week');
});

test('ViewPrefs — the card carries its ledger by default, and off is remembered per tree', () => {
  const prefs = new ViewPrefs(memoryStorage());
  assert.equal(prefs.cardLedger('t1'), true);

  prefs.setCardLedger('t1', false);
  assert.equal(prefs.cardLedger('t1'), false);
  assert.equal(prefs.cardLedger('t2'), true);

  prefs.setCardLedger('t1', true);
  assert.equal(prefs.cardLedger('t1'), true);
});

test('ViewPrefs — the two slots do not collide, and a later write keeps the earlier tree', () => {
  const storage = memoryStorage();
  const prefs = new ViewPrefs(storage);

  prefs.setLastView('t1', 'list');
  prefs.setFoldedSections('t1', ['a']);
  prefs.setLastView('t2', 'tree');

  assert.equal(prefs.lastView('t1'), 'list');
  assert.equal(prefs.lastView('t2'), 'tree');
  assert.deepEqual(prefs.foldedSections('t1'), ['a']);
});

test('ViewPrefs — a garbage slot reads as empty rather than throwing', () => {
  const storage = memoryStorage();
  storage.setItem('windmill:view:last', '{ not json');
  storage.setItem('windmill:view:folded', '["stray-array"]');
  const prefs = new ViewPrefs(storage);

  assert.equal(prefs.lastView('t1'), null);
  assert.deepEqual(prefs.foldedSections('t1'), []);
});

test('ViewPrefs — a throwing storage never throws and reads as empty', () => {
  const prefs = new ViewPrefs(throwingStorage());

  assert.equal(prefs.lastView('t1'), null);
  assert.deepEqual(prefs.foldedSections('t1'), []);
  assert.equal(prefs.cardUnit('t1'), 'week');
  assert.equal(prefs.cardLedger('t1'), true);
  assert.doesNotThrow(() => prefs.setLastView('t1', 'list'));
  assert.doesNotThrow(() => prefs.setFoldedSections('t1', ['a']));
  assert.doesNotThrow(() => prefs.setCardUnit('t1', 'day'));
  assert.doesNotThrow(() => prefs.setCardLedger('t1', false));
  assert.equal(prefs.lastView('t1'), null);
});

test('initialView — an empty tree always opens as the bud canvas, saved choice notwithstanding', () => {
  assert.equal(initialView({ saved: 'list', owner: true, empty: true }), 'tree');
  assert.equal(initialView({ saved: 'tree', owner: false, empty: true }), 'tree');
  assert.equal(initialView({ saved: null, owner: true, empty: true }), 'tree');
});

test('initialView — a saved choice wins on a non-empty tree', () => {
  assert.equal(initialView({ saved: 'list', owner: false, empty: false }), 'list');
  assert.equal(initialView({ saved: 'tree', owner: true, empty: false }), 'tree');
});

test('initialView — no saved choice sends the owner to work and the visitor to the portrait', () => {
  assert.equal(initialView({ saved: null, owner: true, empty: false }), 'list');
  assert.equal(initialView({ saved: null, owner: false, empty: false }), 'tree');
});

test('initialView — a just-born tree opens on the canvas over every other signal', () => {
  assert.equal(initialView({ saved: 'list', owner: true, empty: false, born: true }), 'tree');
  assert.equal(initialView({ saved: null, owner: true, empty: false, born: true }), 'tree');
  assert.equal(initialView({ saved: null, owner: true, empty: false, born: false }), 'list');
});

test('birth stamp — peek reads without consuming; clear removes only the tree it names', () => {
  const storage = memoryStorage();
  stampBorn('t1', storage);

  assert.equal(peekBorn('t2', storage), false);
  assert.equal(peekBorn('t1', storage), true);
  assert.equal(peekBorn('t1', storage), true);

  clearBorn('t2', storage);
  assert.equal(peekBorn('t1', storage), true);
  clearBorn('t1', storage);
  assert.equal(peekBorn('t1', storage), false);
});

test('birth stamp — a later plant replaces the earlier stamp', () => {
  const storage = memoryStorage();
  stampBorn('t1', storage);
  stampBorn('t2', storage);

  assert.equal(peekBorn('t1', storage), false);
  assert.equal(peekBorn('t2', storage), true);
});

test('birth stamp — a throwing storage never throws and reads as not born', () => {
  const storage = throwingStorage();

  assert.doesNotThrow(() => stampBorn('t1', storage));
  assert.doesNotThrow(() => clearBorn('t1', storage));
  assert.equal(peekBorn('t1', storage), false);
});
