import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { SyncStore } from '../../../../src/products/roadmap/sync/SyncStore.js';
import { bearImportedTree, bearLocalTree, deviceKeepsTrees, loadDeviceTree, renameLocalTree, setLocalGuide, moveLocalTree, deleteLocalTree, forgetDeviceTrees } from '../../../../src/products/roadmap/sync/localTrees.js';
import { LocalTreeRegistry } from '../../../../src/products/roadmap/persistence/LocalTreeRegistry.js';

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
