import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { SyncStore } from '../../../../src/products/roadmap/sync/SyncStore.js';
import { MissingDeviceTree, bearImportedTree, bearLocalTree, deviceKeepsTrees, loadDeviceTree, renameLocalTree, setLocalGuide, moveLocalTree, deleteLocalTree, forgetDeviceTrees,
  listDeviceTrees, readDeviceTreeCard, readDeviceTrees, removeDeviceOpeners } from '../../../../src/products/roadmap/sync/localTrees.js';
import { LocalTreeRegistry } from '../../../../src/products/roadmap/persistence/LocalTreeRegistry.js';
import { BoundaryFailure } from '../../../../src/products/roadmap/reportFailure.js';
import { HlcClock, TreeLattice } from '../../../../src/products/roadmap/sync/lattice.js';
import { ProgressLattice } from '../../../../src/products/roadmap/sync/progressLattice.js';

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

test('a record the device cannot read is reported once as a device read, and the picker\'s list stands unread with its failure judged', async (t) => {
  await deviceTrees(t);
  const load = SyncStore.prototype.load;
  t.mock.method(SyncStore.prototype, 'load', async function (treeId) {
    if (treeId === 't_summer') throw new DOMException('gone', 'UnknownError');
    return load.call(this, treeId);
  });
  const reports = [];
  const report = (operation, error) => reports.push({ operation, name: error.name });

  await assert.rejects(readDeviceTrees({ report }), BoundaryFailure);
  assert.deepEqual(reports, [{ operation: 'roadmap-device-opens-read', name: 'UnknownError' }]);
  const listed = await listDeviceTrees(() => readDeviceTrees({ report }));
  assert.deepEqual({ ...listed, failure: listed.failure instanceof BoundaryFailure }, { rows: [], authoritative: false, status: 0, failure: true });
});

test('removing a device tree takes the steps of the other trees here that open it: tombstoned, their edges gone with nothing respliced, their marks cleared', async (t) => {
  const { store } = await deviceTrees(t);
  const reports = [];

  await removeDeviceOpeners('t_sail', { report: (operation) => reports.push(operation) });

  assert.deepEqual(shapeOf(await readDeviceTrees()), {
    t_year: { title: 'My year', steps: [['plan', '', []], ['coast', '', []]], completed: ['plan'] },
    t_sail: { title: 'Learn to sail', steps: [['rig', '', []], ['wind', '', []]], completed: ['rig'] },
    t_summer: { title: 'Summer plans', steps: [['swim', '', []]], completed: [] },
    t_seeded: { title: 'Seeded', steps: [['one', '', []], ['two', '', []]], completed: ['one'] },
  });
  const year = await store.load('t_year');
  assert.deepEqual(year.progress.marks.map(({ node, status }) => [node, status]), [['plan', 'complete'], ['sail', 'none']]);
  const removedAt = year.frame.nodes.find((step) => step.id === 'sail').deletedAt;
  assert.deepEqual(Object.keys(year.gestures.structure), ['1:0:a', removedAt]);
  assert.deepEqual(Object.keys(year.gestures.progress), ['2:0:a', removedAt]);
  assert.deepEqual((await store.load('t_server')).frame, stored([['far', 't_sail']]).frame);
  assert.deepEqual(reports, []);
});

test('the tree open in this tab takes its share through its session, as a local write, and the others through their records', async (t) => {
  const { store } = await deviceTrees(t);
  const lattice = new TreeLattice('t_year', 'My year');
  lattice.join(stored([['plan'], ['sail', 't_sail'], ['coast']], [['plan', 'sail'], ['sail', 'coast']]).frame);
  const progress = new ProgressLattice();
  progress.join(stored([], [], [['sail', 'complete'], ['plan', 'complete']]).progress);
  const clock = new HlcClock('r_live');
  lattice.seedClock(clock);
  const applied = [];
  const marked = [];
  const live = { treeId: 't_year', ready: true, closed: false, lattice, progress, clock,
    apply(writes) { applied.push(writes); lattice.join(writes); }, markProgress: (ids, status) => marked.push([ids, status]) };

  await removeDeviceOpeners('t_sail', { live });

  const at = applied[0].nodes[0].deletedAt;
  assert.deepEqual(applied, [{ nodes: [{ id: 'sail', deletedAt: at }], edges: [{ from: 'plan', to: 'sail', removedAt: at }, { from: 'sail', to: 'coast', removedAt: at }], kinds: [] }]);
  assert.deepEqual(marked, [[['sail'], 'none']]);
  assert.deepEqual(lattice.toTreeData().nodes.map((step) => [step.id, step.prerequisites]), [['plan', []], ['coast', []]]);
  assert.deepEqual((await store.load('t_year')).frame, stored([['plan'], ['sail', 't_sail'], ['coast']], [['plan', 'sail'], ['sail', 'coast']]).frame);
  assert.deepEqual(shapeOf(await readDeviceTrees()).t_summer.steps, [['swim', '', []]]);
});

test('a tree whose write fails keeps its steps, the others\' still go, and the cascade reports once', async (t) => {
  await deviceTrees(t);
  const save = SyncStore.prototype.save;
  t.mock.method(SyncStore.prototype, 'save', async function (treeId, value) {
    if (treeId === 't_year' || treeId === 't_seeded') throw new DOMException('full', 'QuotaExceededError');
    return save.call(this, treeId, value);
  });
  t.mock.method(SyncStore.prototype, 'load', async function (treeId) {
    if (treeId === 't_seeded') throw new DOMException('gone', 'UnknownError');
    return (await this.records()).transact(treeId, 'readonly', (row) => row ?? null);
  });
  const reports = [];

  await removeDeviceOpeners('t_sail', { report: (operation, error) => reports.push({ operation, name: error.name }) });

  t.mock.restoreAll();
  const trees = shapeOf(await readDeviceTrees());
  assert.deepEqual([trees.t_year.steps.map(([id]) => id), trees.t_summer.steps.map(([id]) => id)], [['plan', 'sail', 'coast'], ['swim']]);
  assert.deepEqual(reports, [{ operation: 'roadmap-device-cascade', name: 'QuotaExceededError' }]);
});
