import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { SyncStore } from '../../../../src/products/roadmap/sync/SyncStore.js';
import { MissingDeviceTree, bearImportedTree, bearLocalTree, deviceKeepsTrees, loadDeviceTree, renameLocalTree, setLocalGuide, moveLocalTree, deleteLocalTree, forgetDeviceTrees,
  deleteDeviceTree, listDeviceTrees, readDeviceTreeCard, readDeviceTrees, repointDeviceSteps } from '../../../../src/products/roadmap/sync/localTrees.js';
import { SyncSession } from '../../../../src/products/roadmap/sync/SyncSession.js';
import { OpenedTrees } from '../../../../src/products/roadmap/model/OpenedTrees.js';
import { deleteCost, withDeviceOpeners } from '../../../../src/products/roadmap/identity/deleteCost.js';
import { LocalTreeRegistry } from '../../../../src/products/roadmap/persistence/LocalTreeRegistry.js';
import { BoundaryFailure } from '../../../../src/products/roadmap/reportFailure.js';
import { TreeLattice } from '../../../../src/products/roadmap/sync/lattice.js';

const frame = { nodes: [{ id: 'root', createdAt: '1:0:server', label: 'Root', labelAt: '1:0:server' }], edges: [], kinds: [] };

function device(t) {
  const rows = new Map();
  const storage = { getItem: (key) => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value), removeItem: (key) => rows.delete(key) };
  for (const [key, value] of Object.entries({ indexedDB: new IDBFactory(), window: { localStorage: storage }, localStorage: storage })) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (prior) Object.defineProperty(globalThis, key, prior);
      else delete globalThis[key];
    });
  }
  const registry = new LocalTreeRegistry();
  registry.record('source', 'Original');
  return { registry, store: new SyncStore() };
}

test('local rename carries the loaded epoch after a discard and preserves the confirmed baseline', async (t) => {
  const { store, registry } = device(t);
  await store.save('source', { frame, confirmed: { structure: frame }, lastSeq: 1 });
  await store.replaceLane('source', 'structure', 0);
  await renameLocalTree('source', 'Renamed');
  const saved = await store.load('source');
  assert.equal(saved.epochs.structure, 1);
  assert.equal(saved.frame.title.v, 'Renamed');
  assert.deepEqual(saved.frame.nodes, frame.nodes);
  assert.deepEqual(saved.confirmed.structure, frame);
  assert.equal(registry.get('source').title, 'Renamed');
});

test('local rename retries from the authoritative value if a discard races its loaded snapshot', async (t) => {
  const { store, registry } = device(t);
  await store.save('source', { frame, confirmed: { structure: frame } });
  const save = SyncStore.prototype.save;
  let raced = false;
  t.mock.method(SyncStore.prototype, 'save', async function(treeId, value) {
    if (!raced && value.frame.title) {
      raced = true;
      await store.replaceLane(treeId, 'structure', 0);
    }
    return save.call(this, treeId, value);
  });
  await renameLocalTree('source', 'Renamed after discard');
  const saved = await store.load('source');
  assert.equal(saved.epochs.structure, 1);
  assert.equal(saved.frame.title.v, 'Renamed after discard');
  assert.deepEqual(saved.frame.nodes, frame.nodes);
  assert.equal(registry.get('source').title, 'Renamed after discard');
});

test('a move never deletes its source when the destination has a newer discard epoch', async (t) => {
  const { store, registry } = device(t);
  await store.save('source', { frame });
  await store.save('destination', { frame, confirmed: { structure: frame } });
  await store.replaceLane('destination', 'structure', 0);
  const before = await store.load('source');
  await assert.rejects(moveLocalTree('source', 'destination'), { message: 'local tree destination changed' });
  assert.deepEqual(await store.load('source'), before);
  assert.equal(registry.get('source').title, 'Original');
  assert.equal(registry.get('destination'), null);
});

for (const action of [deleteLocalTree, forgetDeviceTrees]) {
  test(`${action.name} removes obsolete share history and card preferences`, async (t) => {
    const original = globalThis.window;
    const originalDatabase = globalThis.indexedDB;
    globalThis.indexedDB = new IDBFactory();
    t.after(() => { globalThis.indexedDB = originalDatabase; });
    const disk = new Map([
      ['windmill:shared:t_old', JSON.stringify({ completed: ['n_private'], history: [{ at: 100, delta: 1 }] })],
      ['windmill:shared:t_orphan', '{}'],
      ['windmill:card:unit', '{"t_old":"day"}'],
      ['windmill:card:ledger', '{"t_old":true}'],
      ['unrelated', 'keep'],
    ]);
    globalThis.window = { localStorage: {
      get length() { return disk.size; },
      key: (index) => [...disk.keys()][index] ?? null,
      getItem: (key) => disk.get(key) ?? null,
      setItem: (key, value) => disk.set(key, value),
      removeItem: (key) => disk.delete(key),
    } };
    t.after(() => { globalThis.window = original; });
    await action('t_old');
    assert.deepEqual([...disk.entries()].filter(([key]) => key.startsWith('windmill:shared:') || key.startsWith('windmill:card:')), []);
    assert.equal(disk.get('unrelated'), 'keep');
  });
}

test('tracked local renames retain gesture history through repeated title changes and an id move', async (t) => {
  const { store } = device(t);
  await store.save('source', { frame, confirmed: { structure: frame }, gestures: { structure: {}, progress: {} } });
  await renameLocalTree('source', 'First title');
  const first = await store.load('source');
  assert.deepEqual(Object.keys(first.gestures.structure), [first.frame.title.at]);
  await renameLocalTree('source', 'Second title');
  const second = await store.load('source');
  assert.deepEqual(Object.keys(second.gestures.structure), [first.frame.title.at, second.frame.title.at]);
  await moveLocalTree('source', 'destination');
  const moved = await store.load('destination');
  assert.deepEqual(moved.gestures, second.gestures);
  assert.equal(await store.load('source'), null);
  assert.equal(moved.frame.title.v, 'Second title');
});

const plan = { title: 'Pottery', kinds: [], nodes: [{ id: 'clay', label: 'Wedge clay', color: 'terracotta', prerequisites: [] }] };

function refuseDatabase(t) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() { throw new DOMException('refused', 'SecurityError'); } } });
  t.after(() => Object.defineProperty(globalThis, 'indexedDB', prior));
}

function refuseIndex(registry) {
  globalThis.window.localStorage = { ...registry.storage, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
}

test('a device whose database and index both answer keeps a plant: the index row and the lattice stand', async (t) => {
  const { registry, store } = device(t);
  assert.equal(await deviceKeepsTrees(), true);
  const treeId = await bearImportedTree(plan);
  assert.deepEqual((await store.load(treeId)).frame.nodes.map(({ id, label }) => ({ id, label })), [{ id: 'clay', label: 'Wedge clay' }]);
  assert.equal(registry.entries()[treeId].title, 'Pottery');
});

for (const [refusal, refuse] of [
  ['a refused database', (t) => refuseDatabase(t)],
  ['a full index', (t, registry) => refuseIndex(registry)],
]) {
  test(`${refusal} refuses a plant before anything is written, and says so before anyone types`, async (t) => {
    const { registry } = device(t);
    refuse(t, registry);
    assert.equal(await deviceKeepsTrees(), false);
    await assert.rejects(bearImportedTree(plan), { name: 'SecurityError' });
    await assert.rejects(bearLocalTree({ title: 'Pottery' }), { name: 'SecurityError' });
    assert.deepEqual(Object.keys(registry.entries()), ['source']);
  });
}

test('a lattice the store refuses to take leaves no index row behind: the plant was not accepted', async (t) => {
  const { registry } = device(t);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = () => { throw new DOMException('full', 'QuotaExceededError'); };
  t.after(() => { IDBObjectStore.prototype.put = put; });
  await assert.rejects(bearImportedTree(plan), { name: 'SecurityError' });
  assert.deepEqual(Object.keys(registry.entries()), ['source']);
});

test('a device tree keeps its guide in its blob as one stamped write that the claim will flush, and the index keeps its title', async (t) => {
  const { store, registry } = device(t);
  await store.save('source', { frame, confirmed: { structure: frame }, gestures: { structure: {}, progress: {} } });
  await setLocalGuide('source', 'Written on this device.');
  const saved = await store.load('source');
  assert.equal(saved.frame.guide.v, 'Written on this device.');
  assert.deepEqual(Object.keys(saved.gestures.structure), [saved.frame.guide.at]);
  assert.deepEqual(saved.frame.nodes, frame.nodes);
  assert.equal(registry.get('source').title, 'Original');
  globalThis.window.wmDeviceConfirmation = { owner: null };
  const opened = await loadDeviceTree('source', { ownerResolved: true });
  assert.deepEqual({ title: opened.title, guide: opened.guide }, { title: 'Original', guide: 'Written on this device.' });
  await moveLocalTree('source', 'destination');
  assert.deepEqual((await store.load('destination')).frame.guide, saved.frame.guide);
});

test('a guide for a device tree whose record is gone is refused, not counted as written; a rename still renames the index', async (t) => {
  const { store, registry } = device(t);
  await assert.rejects(setLocalGuide('source', 'Written.'), MissingDeviceTree);
  assert.equal(await store.load('source'), null);
  await renameLocalTree('source', 'Renamed');
  assert.equal(registry.get('source').title, 'Renamed');
});

// A tree as its session stores it: its steps, each `[id, opens]`, its edges `[from, to]`, and its marks `[step, status]`.
function stored(steps, edges = [], marks = []) {
  return {
    frame: {
      nodes: steps.map(([id, opens, status]) => ({ id, createdAt: '1:0:a', label: id, labelAt: '1:0:a', ...(opens ? { opens, opensAt: '1:0:a' } : {}),
        ...(status ? { status, statusAt: '1:0:a' } : {}) })),
      edges: edges.map(([from, to]) => ({ from, to, addedAt: '1:0:a' })),
      kinds: [],
    },
    progress: { marks: marks.map(([node, status]) => ({ node, status, at: '2:0:a' })) },
  };
}

// This device's trees for the cases below: My year and Summer plans open Learn to sail; Seeded holds its import's marks;
// Kept on the server was claimed, and one of its steps opens Learn to sail too.
async function deviceTrees(t) {
  const { registry, store } = device(t);
  registry.write({
    t_year: { title: 'My year', updatedAt: 5, claimed: false, owner: null },
    t_sail: { title: 'Learn to sail', updatedAt: 4, claimed: false, owner: null },
    t_summer: { title: 'Summer plans', updatedAt: 3, claimed: false, owner: null },
    t_seeded: { title: 'Seeded', updatedAt: 2, claimed: false, owner: null },
    t_server: { title: 'Kept on the server', updatedAt: 1, claimed: true, owner: null },
  });
  await store.save('t_year', stored([['plan'], ['sail', 't_sail'], ['coast']], [['plan', 'sail'], ['sail', 'coast']], [['plan', 'complete'], ['sail', 'complete']]));
  await store.save('t_sail', stored([['rig'], ['wind']], [], [['rig', 'complete'], ['wind', 'none']]));
  await store.save('t_summer', stored([['plan2', 't_sail'], ['swim']]));
  await store.save('t_seeded', stored([['one', '', 'complete'], ['two']]));
  await store.save('t_server', stored([['far', 't_sail']]));
  return { registry, store };
}

const shapeOf = (trees) => Object.fromEntries([...trees].map(([id, tree]) => [id,
  { title: tree.title, steps: tree.nodes.map((step) => [step.id, step.opens ?? '', step.prerequisites]), completed: [...tree.completed] }]));

test('the device reads the trees that live only here: each one\'s steps and the marks its room shows, and none an account claimed', async (t) => {
  await deviceTrees(t);

  assert.deepEqual(shapeOf(await readDeviceTrees()), {
    t_year: { title: 'My year', steps: [['plan', '', []], ['sail', 't_sail', ['plan']], ['coast', '', ['sail']]], completed: ['plan', 'sail'] },
    t_sail: { title: 'Learn to sail', steps: [['rig', '', []], ['wind', '', []]], completed: ['rig'] },
    t_summer: { title: 'Summer plans', steps: [['plan2', 't_sail', []], ['swim', '', []]], completed: [] },
    t_seeded: { title: 'Seeded', steps: [['one', '', []], ['two', '', []]], completed: ['one'] },
  });
});

test('the picker lists the device\'s trees newest first, counted on the device, and an address names one of them or none', async (t) => {
  await deviceTrees(t);

  assert.deepEqual(await listDeviceTrees(), { authoritative: true, rows: [
    { id: 't_year', title: 'My year', done: 1, total: 3 },
    { id: 't_sail', title: 'Learn to sail', done: 1, total: 2 },
    { id: 't_summer', title: 'Summer plans', done: 0, total: 2 },
    { id: 't_seeded', title: 'Seeded', done: 1, total: 2 },
  ] });
  assert.deepEqual(await readDeviceTreeCard('t_sail'), { id: 't_sail', title: 'Learn to sail', author: null, steps: null, mine: true });
  assert.equal(await readDeviceTreeCard('t_server'), null);
  assert.equal(await readDeviceTreeCard('t_0123456789abcdef'), null);
});

test('a device that cannot read its trees reports once under the name of what failed, and the picker\'s list stands unread with its failure judged', async (t) => {
  await deviceTrees(t);
  const load = SyncStore.prototype.load;
  t.mock.method(SyncStore.prototype, 'load', async function (treeId) {
    if (treeId === 't_summer') throw new DOMException('gone', 'UnknownError');
    return load.call(this, treeId);
  });
  const reports = [];
  const report = (operation, error, tags) => reports.push({ operation, name: error.name, tags });

  await assert.rejects(readDeviceTrees({ report }), BoundaryFailure);
  assert.deepEqual(reports, [{ operation: 'roadmap-device-opens-read', name: 'UnknownError', tags: { name: 'UnknownError' } }]);
  const listed = await listDeviceTrees(() => readDeviceTrees({ report }));
  assert.deepEqual({ ...listed, failure: listed.failure instanceof BoundaryFailure }, { rows: [], authoritative: false, status: 0, failure: true });
});

test('a database that will not open is a device that cannot read its trees, not one that holds none', async (t) => {
  await deviceTrees(t);
  t.mock.method(SyncStore.prototype, 'db', () => Promise.reject(new DOMException('backing store', 'UnknownError')));
  const reports = [];

  await assert.rejects(readDeviceTrees({ report: (operation, error, tags) => reports.push([operation, tags]) }), BoundaryFailure);
  assert.deepEqual(reports, [['roadmap-device-opens-read', { name: 'UnknownError' }]]);
});

test('a record that does not join degrades only itself: it is reported once as corrupt, stands unread and opens nothing, and the rest are read and counted', async (t) => {
  const { store } = await deviceTrees(t);
  const records = await store.records();
  await records.transact('t_summer', 'readwrite', (row, put) => put({ ...row, frame: { nodes: 5, edges: [], kinds: [] } }));
  const reports = [];

  const trees = await readDeviceTrees({ report: (operation, error, tags) => reports.push([operation, tags]) });

  assert.deepEqual(reports, [['roadmap-device-opens-read', { name: 'corrupt' }]]);
  assert.deepEqual(trees.get('t_summer'), { title: 'Summer plans', unread: true, nodes: [], completed: new Set() });
  assert.deepEqual(new OpenedTrees(trees).openersOf('t_sail'), [{ treeId: 't_year', steps: 1 }]);
  assert.deepEqual((await listDeviceTrees(() => Promise.resolve(trees))).rows.map((row) => row.id), ['t_year', 't_sail', 't_seeded']);
});

// A device with nobody signed in: an open tab's session never reaches a server.
class QuietSocket {
  static OPEN = 1;
  constructor() { this.readyState = 0; }
  addEventListener() {}
  send() { throw new Error('nothing may be sent'); }
  close() {}
}

function sessions(t) {
  for (const [key, value] of Object.entries({ WebSocket: QuietSocket, document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' } })) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (prior) Object.defineProperty(globalThis, key, prior);
      else delete globalThis[key];
    });
  }
  Object.assign(globalThis.window, { addEventListener() {}, removeEventListener() {} });
  return async (store, treeId, title, failures = []) => {
    const session = new SyncSession({ treeId, title, registry: null, store, reportFailure: (operation, error) => failures.push([operation, error?.name]) });
    await session.start();
    t.after(() => session.close());
    return session;
  };
}

const present = (lattice) => lattice.toTreeData().nodes.map((step) => [step.id, step.opens ?? '', step.prerequisites]);
const stepsOf = async (store, treeId) => {
  const lattice = new TreeLattice(treeId);
  lattice.join((await store.load(treeId)).frame);
  return present(lattice);
};

test('deleting a device tree takes the steps of the other trees here that open it, exactly as the line counted them: tombstoned, their edges gone with nothing respliced, their marks cleared', async (t) => {
  const { registry, store } = await deviceTrees(t);
  const rows = registry.list().map((row) => ({ ...row, origin: 'device' }));
  const counted = withDeviceOpeners(rows, await readDeviceTrees());
  const reports = [];

  await deleteDeviceTree('t_sail', { report: (operation) => reports.push(operation) });

  assert.deepEqual(deleteCost(counted.find((row) => row.id === 't_sail'), counted, { untitled: 'Untitled roadmap' }), { form: 'two', steps: 2, first: 'My year', second: 'Summer plans' });
  assert.deepEqual(shapeOf(await readDeviceTrees()), {
    t_year: { title: 'My year', steps: [['plan', '', []], ['coast', '', []]], completed: ['plan'] },
    t_summer: { title: 'Summer plans', steps: [['swim', '', []]], completed: [] },
    t_seeded: { title: 'Seeded', steps: [['one', '', []], ['two', '', []]], completed: ['one'] },
  });
  const year = await store.load('t_year');
  assert.deepEqual(year.progress.marks.map(({ node, status }) => [node, status]), [['plan', 'complete'], ['sail', 'none']]);
  const removedAt = year.frame.nodes.find((step) => step.id === 'sail').deletedAt;
  assert.deepEqual(Object.keys(year.gestures.structure), ['1:0:a', removedAt]);
  assert.deepEqual(Object.keys(year.gestures.progress), ['2:0:a', removedAt]);
  assert.deepEqual((await store.load('t_server')).frame, stored([['far', 't_sail']]).frame);
  assert.equal(await store.load('t_sail'), null);
  assert.equal(registry.get('t_sail'), null);
  assert.deepEqual(reports, []);
});

test('the tree open in this tab takes its share through its session, outside the undo journal, and saves it once; ⌘Z after it touches only the act it undoes', async (t) => {
  const { store } = await deviceTrees(t);
  const session = await sessions(t)(store, 't_year', 'My year');
  assert.ok(session.dispatch({ kind: 'SetNodeTree', id: 'coast', opens: 't_summer' }));

  await deleteDeviceTree('t_sail', { live: session });
  await store.chain;

  assert.equal(session.undoStack.length, 1);
  assert.deepEqual(present(session.lattice), [['plan', '', []], ['coast', 't_summer', []]]);
  assert.deepEqual([...session.progress.overlay().completed], ['plan']);
  assert.deepEqual(await stepsOf(store, 't_year'), [['plan', '', []], ['coast', 't_summer', []]]);
  assert.deepEqual(await stepsOf(store, 't_summer'), [['swim', '', []]]);
  session.undo();
  assert.deepEqual(present(session.lattice), [['plan', '', []], ['coast', '', []]]);
});

test('the open tab\'s own tree that cannot save its share reports once, as the cascade, under the name of what failed', async (t) => {
  const { store } = await deviceTrees(t);
  const failures = [];
  const session = await sessions(t)(store, 't_year', 'My year', failures);
  const put = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, 'put', function (value, key) {
    if (key === 't_year') throw new DOMException('forced', 'QuotaExceededError');
    return put.call(this, value, key);
  });
  const reports = [];

  await deleteDeviceTree('t_sail', { live: session, report: (operation, error, tags) => reports.push([operation, tags]) });
  await store.chain;
  t.mock.restoreAll();

  assert.deepEqual(reports, [['roadmap-device-cascade', { name: 'QuotaExceededError' }]]);
  assert.deepEqual(failures, []);
  assert.deepEqual(present(session.lattice).map(([id]) => id), ['plan', 'coast']);
  assert.deepEqual((await stepsOf(store, 't_year')).map(([id]) => id), ['plan', 'sail', 'coast'], 'on disk the steps stand, to come back as Not found');
});

test('a closed tree whose write the browser fails at its request keeps its steps, the others still go, and the cascade reports once under that name', async (t) => {
  const { store } = await deviceTrees(t);
  const put = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, 'put', function (value, key) {
    const request = put.call(this, value, key);
    if (key === 't_summer') this.add(value, key);
    return request;
  });
  const reports = [];

  await deleteDeviceTree('t_sail', { report: (operation, error, tags) => reports.push([operation, error instanceof DOMException, tags]) });
  t.mock.restoreAll();

  assert.deepEqual(reports, [['roadmap-device-cascade', true, { name: 'ConstraintError' }]]);
  assert.deepEqual((await stepsOf(store, 't_summer')).map(([id]) => id), ['plan2', 'swim']);
  assert.deepEqual((await stepsOf(store, 't_year')).map(([id]) => id), ['plan', 'coast']);
});

test('a device that cannot read its trees refuses the delete with nothing removed: the tree and every opener stand', async (t) => {
  const { registry, store } = await deviceTrees(t);
  t.mock.method(SyncStore.prototype, 'db', () => Promise.reject(new DOMException('backing store', 'UnknownError')));
  const reports = [];

  await assert.rejects(deleteDeviceTree('t_sail', { report: (operation, error, tags) => reports.push([operation, tags]) }), BoundaryFailure);
  t.mock.restoreAll();

  assert.deepEqual(reports, [['roadmap-device-opens-read', { name: 'UnknownError' }]]);
  assert.equal(registry.get('t_sail').title, 'Learn to sail');
  assert.deepEqual((await stepsOf(store, 't_sail')).map(([id]) => id), ['rig', 'wind']);
  assert.deepEqual((await stepsOf(store, 't_year')).map(([id]) => id), ['plan', 'sail', 'coast']);
});

test('a corrupt record is neither told of nor taken from: the delete goes for the rest and reports no write failure', async (t) => {
  const { store } = await deviceTrees(t);
  const records = await store.records();
  await records.transact('t_summer', 'readwrite', (row, put) => put({ ...row, frame: { nodes: 5, edges: [], kinds: [] } }));
  const reports = [];

  await deleteDeviceTree('t_sail', { report: (operation, error, tags) => reports.push([operation, tags]) });

  assert.deepEqual(reports, [['roadmap-device-opens-read', { name: 'corrupt' }]]);
  assert.deepEqual((await stepsOf(store, 't_year')).map(([id]) => id), ['plan', 'coast']);
  assert.deepEqual((await store.load('t_summer')).frame, { nodes: 5, edges: [], kinds: [] });
});

test('a tree that opens itself and two trees that open each other: deleting one takes its openers and leaves its own pointers to go with it', async (t) => {
  const { registry, store } = device(t);
  registry.write({
    t_self: { title: 'Self', updatedAt: 3, claimed: false, owner: null },
    t_m: { title: 'M', updatedAt: 2, claimed: false, owner: null },
    t_n: { title: 'N', updatedAt: 1, claimed: false, owner: null },
  });
  await store.save('t_self', stored([['again', 't_self'], ['to-m', 't_m']]));
  await store.save('t_m', stored([['to-n', 't_n'], ['m2']]));
  await store.save('t_n', stored([['to-m', 't_m'], ['to-self', 't_self'], ['n2']]));

  await deleteDeviceTree('t_m');

  assert.deepEqual(Object.fromEntries([...(await readDeviceTrees())].map(([id, tree]) => [id, tree.nodes.map((step) => step.id)])), { t_self: ['again'], t_n: ['to-self', 'n2'] });
});

test('a removed tree planted again under its id does not bring back the steps that went with it', async (t) => {
  const { registry, store } = await deviceTrees(t);
  await deleteDeviceTree('t_sail');
  registry.write({ ...registry.entries(), t_sail: { title: 'Again', updatedAt: 10, claimed: false, owner: null } });
  await store.save('t_sail', stored([['new']]));

  const trees = await readDeviceTrees();

  assert.deepEqual([trees.get('t_year').nodes.map((step) => step.id), trees.get('t_summer').nodes.map((step) => step.id)], [['plan', 'coast'], ['swim']]);
});

test('a tree given a fresh id keeps every pointer at it: each tree on the device that opened it, up or not, opens the fresh id, the open one through its session', async (t) => {
  const { store } = await deviceTrees(t);
  const session = await sessions(t)(store, 't_year', 'My year');
  const undo = session.undoStack.length;

  const written = await repointDeviceSteps('t_sail', 't_fresh', { live: session });
  await store.chain;

  assert.deepEqual(written, ['t_year', 't_summer', 't_server']);
  assert.deepEqual(present(session.lattice), [['plan', '', []], ['sail', 't_fresh', ['plan']], ['coast', '', ['sail']]]);
  assert.equal(session.undoStack.length, undo);
  assert.deepEqual(await stepsOf(store, 't_summer'), [['plan2', 't_fresh', []], ['swim', '', []]]);
  assert.deepEqual(await stepsOf(store, 't_server'), [['far', 't_fresh', []]]);
  assert.deepEqual(await stepsOf(store, 't_seeded'), [['one', '', []], ['two', '', []]]);
  assert.equal(Object.keys((await store.load('t_summer')).gestures.structure).length, 2, 'the pointer write is owed, to go up with the tree');
});
