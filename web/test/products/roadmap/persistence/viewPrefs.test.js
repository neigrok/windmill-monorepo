import test from 'node:test';
import assert from 'node:assert/strict';

import { ViewPrefs, initialView, boardCanShow, viewToShow, stampBorn, peekBorn, clearBorn, notePlantedQuest, noteForked, takePlantNote } from '../../../../src/products/roadmap/persistence/ViewPrefs.js';

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

  prefs.setLastView('t2', 'tree');
  prefs.setLastView('t3', 'board');
  assert.equal(prefs.lastView('t2'), 'tree');
  assert.equal(prefs.lastView('t3'), 'board');
  assert.equal(prefs.lastView('t4'), null);
});

test('ViewPrefs — a saved `list` from before the Board still reads, and `list` is never written again', () => {
  const storage = memoryStorage();
  storage.setItem('windmill:view:last', JSON.stringify({ t1: 'list' }));
  const prefs = new ViewPrefs(storage);
  assert.equal(prefs.lastView('t1'), 'list');
  prefs.setLastView('t2', 'list');
  assert.equal(prefs.lastView('t2'), null);
  assert.equal(storage.getItem('windmill:view:last'), JSON.stringify({ t1: 'list' }));
});

test('ViewPrefs — a view this device does not know reads as no choice', () => {
  const storage = memoryStorage();
  storage.setItem('windmill:view:last', JSON.stringify({ t1: 'kanban' }));
  assert.equal(new ViewPrefs(storage).lastView('t1'), null);
});

test('ViewPrefs — a later write keeps the earlier tree', () => {
  const prefs = new ViewPrefs(memoryStorage());

  prefs.setLastView('t1', 'board');
  prefs.setLastView('t2', 'tree');

  assert.equal(prefs.lastView('t1'), 'board');
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
  assert.doesNotThrow(() => prefs.setLastView('t1', 'board'));
  assert.equal(prefs.lastView('t1'), null);
});

test('initialView — a step link opens the Board for owner and visitor alike', () => {
  assert.deepEqual([
    initialView({ saved: 'tree', owner: true, empty: false, linkedStep: 'wind' }).view,
    initialView({ saved: null, owner: false, empty: false, linkedStep: 'wind' }).view,
    initialView({ saved: null, owner: false, empty: false, born: true, linkedStep: 'wind' }).view,
  ], ['board', 'board', 'tree']);
});

test('initialView — an empty tree opens on the canvas, saved choice notwithstanding, without an owner who can plant it', () => {
  assert.equal(initialView({ saved: 'list', owner: true, empty: true }).view, 'tree');
  assert.equal(initialView({ saved: 'tree', owner: false, empty: true }).view, 'tree');
  assert.equal(initialView({ saved: null, owner: true, empty: true }).view, 'tree');
});

test('initialView — no saved choice sends the owner to the Board and the visitor to the Graph', () => {
  assert.equal(initialView({ saved: null, owner: true, empty: false }).view, 'board');
  assert.equal(initialView({ saved: null, owner: false, empty: false }).view, 'tree');
});

test('initialView — a just-born tree opens on the canvas over every other signal', () => {
  assert.equal(initialView({ saved: 'list', owner: true, empty: false, born: true }).view, 'tree');
  assert.equal(initialView({ saved: 'board', owner: true, empty: false, born: true }).view, 'tree');
  assert.equal(initialView({ saved: null, owner: true, empty: false, born: true }).view, 'tree');
  assert.equal(initialView({ saved: null, owner: true, empty: false, born: false }).view, 'board');
});

test('initialView — an owner keeps the saved choice, a saved `list` reads as `board`, and a reader opens the Graph', () => {
  assert.equal(initialView({ saved: 'tree', owner: true, empty: false }).view, 'tree');
  assert.equal(initialView({ saved: 'board', owner: true, empty: false }).view, 'board');
  assert.equal(initialView({ saved: 'list', owner: true, empty: false }).view, 'board');
  assert.equal(initialView({ saved: 'board', owner: false, reader: true, empty: false }).view, 'tree');
});

test('initialView — readers land on the Graph for every saved choice unless a step link opens the Board', () => {
  for (const saved of [null, 'tree', 'list', 'board']) {
    assert.deepEqual([
      initialView({ saved, owner: false, reader: true, empty: false }).view,
      initialView({ saved, owner: false, reader: true, empty: false, linkedStep: 'wind' }).view,
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
    assert.deepEqual(choices.map((saved) => initialView({ saved, owner, reader, empty: false }).view), expected, label);
    assert.deepEqual(choices.map((saved) => initialView({ saved, owner, reader, empty: false, linkedStep: 'wind' }).view), ['board', 'board', 'board', 'board'], label);
  }
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
    viewToShow('tree', { loaded: false }),
    viewToShow(null, { loaded: false }),
  ], ['board', 'board', 'board', 'tree', 'tree', 'tree', null]);
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
      assert.equal(initialView({ saved, owner: true, empty: true, born, canAddFirstStep: true }).view, 'board');
    }
  }
});

test('initialView — the empty Board rule leaves visitors and an owner who cannot plant on the canvas', () => {
  assert.deepEqual([
    initialView({ saved: 'board', owner: false, empty: true, canAddFirstStep: true }).view,
    initialView({ saved: 'board', owner: true, empty: true, canAddFirstStep: false }).view,
  ], ['tree', 'tree']);
});

test('initialView returns the deciding door with the view in branch order', () => {
  const base = { saved: 'tree', owner: true, reader: false, empty: false };
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
  ];
  for (const [overrides, expected] of cases) assert.deepEqual(initialView({ ...base, ...overrides }), expected);
});

test('plant notes — each is read once, and a throwing storage reads as none', () => {
  const storage = memoryStorage();
  assert.deepEqual(takePlantNote(storage), { quest: false, forked: false });
  notePlantedQuest(storage);
  noteForked(storage);
  assert.equal(storage.getItem('windmill:planted-quest'), '1');
  assert.equal(storage.getItem('windmill:forked-from-demo'), '1');
  assert.deepEqual(takePlantNote(storage), { quest: true, forked: true });
  assert.deepEqual(takePlantNote(storage), { quest: false, forked: false });
  noteForked(throwingStorage());
  assert.deepEqual(takePlantNote(throwingStorage()), { quest: false, forked: false });
});

test('an email fork lands on its copy with the same note an instant fork leaves', async (t) => {
  const storage = memoryStorage();
  globalThis.sessionStorage = storage;
  t.after(() => { delete globalThis.sessionStorage; });
  const { roadmapRoutes } = await import('../../../../src/products/roadmap/routes.js');
  assert.equal(roadmapRoutes.landingAfterSignIn('t_copy'), '#/app/t_copy');
  assert.deepEqual(takePlantNote(storage), { quest: false, forked: true });
});
