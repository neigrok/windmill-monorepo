import test from 'node:test';
import assert from 'node:assert/strict';

import { ViewPrefs, initialView, boardCanShow, viewToShow, stampBorn, peekBorn, clearBorn } from '../../../../src/products/roadmap/persistence/ViewPrefs.js';

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
  prefs.setLastView('t3', 'board');
  assert.equal(prefs.lastView('t1'), 'list');
  assert.equal(prefs.lastView('t2'), 'tree');
  assert.equal(prefs.lastView('t3'), 'board');
  assert.equal(prefs.lastView('t4'), null);
});

test('ViewPrefs — a view this device does not know reads as no choice', () => {
  const storage = memoryStorage();
  storage.setItem('windmill:view:last', JSON.stringify({ t1: 'kanban' }));
  assert.equal(new ViewPrefs(storage).lastView('t1'), null);
});

test('ViewPrefs — a later write keeps the earlier tree', () => {
  const prefs = new ViewPrefs(memoryStorage());

  prefs.setLastView('t1', 'list');
  prefs.setLastView('t2', 'tree');

  assert.equal(prefs.lastView('t1'), 'list');
  assert.equal(prefs.lastView('t2'), 'tree');
});

test('ViewPrefs — a garbage slot reads as empty rather than throwing', () => {
  const storage = memoryStorage();
  storage.setItem('windmill:view:last', '{ not json');
  const prefs = new ViewPrefs(storage);

  assert.equal(prefs.lastView('t1'), null);
});

test('ViewPrefs — a throwing storage never throws and reads as empty', () => {
  const prefs = new ViewPrefs(throwingStorage());

  assert.equal(prefs.lastView('t1'), null);
  assert.doesNotThrow(() => prefs.setLastView('t1', 'list'));
  assert.equal(prefs.lastView('t1'), null);
});

test('initialView — a step link opens the Board for owner and visitor alike while the Board is open, and nothing while it is closed', () => {
  assert.deepEqual([
    initialView({ saved: 'tree', owner: true, empty: false, boardOpen: true, linkedStep: 'wind' }).view,
    initialView({ saved: null, owner: false, empty: false, boardOpen: true, linkedStep: 'wind' }).view,
    initialView({ saved: null, owner: false, empty: false, boardOpen: false, linkedStep: 'wind' }).view,
    initialView({ saved: null, owner: false, empty: false, born: true, boardOpen: true, linkedStep: 'wind' }).view,
  ], ['board', 'board', 'tree', 'tree']);
});

test('initialView — an empty tree always opens as the bud canvas, saved choice notwithstanding', () => {
  assert.equal(initialView({ saved: 'list', owner: true, empty: true }).view, 'tree');
  assert.equal(initialView({ saved: 'tree', owner: false, empty: true }).view, 'tree');
  assert.equal(initialView({ saved: null, owner: true, empty: true }).view, 'tree');
});

test('initialView — a saved choice wins on a non-empty tree', () => {
  assert.equal(initialView({ saved: 'list', owner: false, empty: false }).view, 'list');
  assert.equal(initialView({ saved: 'tree', owner: true, empty: false }).view, 'tree');
});

test('initialView — no saved choice sends the owner to work and the visitor to the portrait', () => {
  assert.equal(initialView({ saved: null, owner: true, empty: false }).view, 'list');
  assert.equal(initialView({ saved: null, owner: false, empty: false }).view, 'tree');
});

test('initialView — a just-born tree opens on the canvas over every other signal', () => {
  assert.equal(initialView({ saved: 'list', owner: true, empty: false, born: true }).view, 'tree');
  assert.equal(initialView({ saved: null, owner: true, empty: false, born: true }).view, 'tree');
  assert.equal(initialView({ saved: null, owner: true, empty: false, born: false }).view, 'list');
});

test('initialView — with the Board open, the owner opens on the Board and the visitor on the Graph', () => {
  assert.equal(initialView({ saved: null, owner: true, empty: false, boardOpen: true }).view, 'board');
  assert.equal(initialView({ saved: null, owner: false, empty: false, boardOpen: true }).view, 'tree');
});

test('initialView — with the Board open, an owner keeps the saved choice and a reader opens the Graph', () => {
  assert.equal(initialView({ saved: 'tree', owner: true, empty: false, boardOpen: true }).view, 'tree');
  assert.equal(initialView({ saved: 'board', owner: false, reader: true, empty: false, boardOpen: true }).view, 'tree');
  assert.equal(initialView({ saved: 'list', owner: true, empty: false, boardOpen: true }).view, 'board');
});

test('initialView — with the Board closed, a saved Board becomes the List', () => {
  assert.equal(initialView({ saved: 'board', owner: false, empty: false, boardOpen: false }).view, 'list');
});

test('initialView — readers with the Board open land on the Graph for every saved choice unless a step link opens the Board', () => {
  for (const saved of [null, 'tree', 'list', 'board']) {
    assert.deepEqual([
      initialView({ saved, owner: false, reader: true, empty: false, boardOpen: true }).view,
      initialView({ saved, owner: false, reader: true, empty: false, boardOpen: true, linkedStep: 'wind' }).view,
    ], ['tree', 'board']);
  }
});

test('initialView — confirmed readers override saved choices while the demo and owned shared roadmaps keep them', () => {
  const populations = [
    { label: 'owned roadmap', owner: true, reader: false, expected: ['board', 'tree', 'board', 'board'] },
    { label: 'owned roadmap through a shared URL', owner: false, reader: false, expected: ['tree', 'tree', 'board', 'board'] },
    { label: 'demo on an app URL', owner: false, reader: false, expected: ['tree', 'tree', 'board', 'board'] },
    { label: 'demo on a shared URL', owner: false, reader: false, expected: ['tree', 'tree', 'board', 'board'] },
    { label: 'confirmed not-mine roadmap', owner: false, reader: true, expected: ['tree', 'tree', 'tree', 'tree'] },
    { label: 'ownership-demoted roadmap', owner: false, reader: true, expected: ['tree', 'tree', 'tree', 'tree'] },
    { label: 'loading shared roadmap with ownership unknown', owner: false, reader: false, expected: ['tree', 'tree', 'board', 'board'] },
  ];
  for (const { label, owner, reader, expected } of populations) {
    const choices = [null, 'tree', 'list', 'board'];
    assert.deepEqual(choices.map((saved) => initialView({ saved, owner, reader, empty: false, boardOpen: true }).view), expected, label);
    assert.deepEqual(choices.map((saved) => initialView({ saved, owner, reader, empty: false, boardOpen: true, linkedStep: 'wind' }).view), ['board', 'board', 'board', 'board'], label);
  }
});

test('initialView — gate-closed choices retain all ownership, empty, birth, link and first-step combinations', () => {
  for (const owner of [false, true]) {
    for (const empty of [false, true]) {
      for (const born of [false, true]) {
        for (const linkedStep of [null, 'wind']) {
          for (const canAddFirstStep of [false, true]) {
            const results = [null, 'tree', 'list', 'board'].map((saved) => initialView({
              saved, owner, reader: false, empty, born, linkedStep, canAddFirstStep, boardOpen: false,
            }).view);
            const readerResults = [null, 'tree', 'list', 'board'].map((saved) => initialView({
              saved, owner, reader: true, empty, born, linkedStep, canAddFirstStep, boardOpen: false,
            }).view);
            assert.deepEqual(readerResults, results);
            if (empty || born) {
              assert.deepEqual(results, ['tree', 'tree', 'tree', 'tree']);
              continue;
            }
            assert.deepEqual(results, [owner ? 'list' : 'tree', 'tree', 'list', 'list']);
          }
        }
      }
    }
  }
});

test('initialView — with the Board open, an empty or just-born tree still opens on the canvas', () => {
  assert.equal(initialView({ saved: 'board', owner: true, empty: true, boardOpen: true }).view, 'tree');
  assert.equal(initialView({ saved: 'board', owner: true, empty: false, born: true, boardOpen: true }).view, 'tree');
});

test('boardCanShow — the Board shows while its roadmap loads or fails to, and once loaded with steps', () => {
  assert.deepEqual([
    boardCanShow({ loaded: false }),
    boardCanShow({ loaded: false, empty: true }),
    boardCanShow({ loaded: true, empty: false }),
  ], [true, true, true]);
});

test('boardCanShow — a crashed Board never shows, loading or loaded', () => {
  assert.deepEqual([
    boardCanShow({ crashed: true, loaded: false }),
    boardCanShow({ crashed: true, loaded: true, empty: false, canAddFirstStep: true }),
  ], [false, false]);
});

test('boardCanShow — a roadmap with no steps shows only where New step can plant the first one', () => {
  assert.deepEqual([
    boardCanShow({ loaded: true, empty: true, canAddFirstStep: true }),
    boardCanShow({ loaded: true, empty: true, canAddFirstStep: false }),
  ], [true, false]);
});

test('viewToShow — a Board that cannot show shows the Graph; every other view shows as chosen', () => {
  assert.deepEqual([
    viewToShow('board', { loaded: false }),
    viewToShow('board', { loaded: true, empty: false }),
    viewToShow('board', { loaded: true, empty: true, canAddFirstStep: true }),
    viewToShow('board', { loaded: true, empty: true, canAddFirstStep: false }),
    viewToShow('board', { crashed: true, loaded: true }),
    viewToShow('list', { loaded: true, empty: true }),
    viewToShow('tree', { loaded: false }),
    viewToShow(null, { loaded: false }),
  ], ['board', 'board', 'board', 'tree', 'tree', 'list', 'tree', null]);
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


test('initialView — an owner with an empty Board and New step opens the Board across saved and birth states', () => {
  for (const saved of [null, 'tree', 'list', 'board']) {
    for (const born of [false, true]) {
      assert.equal(initialView({ saved, owner: true, empty: true, born, boardOpen: true, canAddFirstStep: true }).view, 'board');
    }
  }
});

test('initialView — the empty Board rule leaves visitors and the closed gate on the canvas', () => {
  assert.deepEqual([
    initialView({ saved: 'board', owner: false, empty: true, boardOpen: true, canAddFirstStep: true }).view,
    initialView({ saved: 'board', owner: true, empty: true, boardOpen: false, canAddFirstStep: true }).view,
    initialView({ saved: 'board', owner: true, empty: true, boardOpen: true, canAddFirstStep: false }).view,
  ], ['tree', 'tree', 'tree']);
});


test('initialView returns the deciding door with the view in branch order', () => {
  const base = { saved: 'tree', owner: true, reader: false, empty: false, boardOpen: true };
  const cases = [
    [{ empty: true, canAddFirstStep: true, born: true, linkedStep: 'wind' }, { view: 'board', door: 'empty' }],
    [{ born: true, empty: true, linkedStep: 'wind' }, { view: 'tree', door: 'born' }],
    [{ empty: true, linkedStep: 'wind' }, { view: 'tree', door: 'empty' }],
    [{ linkedStep: 'wind', reader: true }, { view: 'board', door: 'link' }],
    [{ owner: false, reader: true, saved: 'board' }, { view: 'tree', door: 'default' }],
    [{}, { view: 'tree', door: 'saved' }],
    [{ saved: 'list' }, { view: 'board', door: 'saved' }],
    [{ saved: 'board' }, { view: 'board', door: 'saved' }],
    [{ saved: null }, { view: 'board', door: 'default' }],
    [{ saved: null, owner: false }, { view: 'tree', door: 'default' }],
    [{ boardOpen: false, saved: 'board', linkedStep: 'wind' }, { view: 'list', door: 'saved' }],
    [{ boardOpen: false, saved: null, linkedStep: 'wind' }, { view: 'list', door: 'default' }],
  ];
  for (const [overrides, expected] of cases) assert.deepEqual(initialView({ ...base, ...overrides }), expected);
});
