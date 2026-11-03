import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { SyncStore } from '../../../../src/products/roadmap/sync/SyncStore.js';
import { renameLocalTree, moveLocalTree, deleteLocalTree, forgetDeviceTrees } from '../../../../src/products/roadmap/sync/localTrees.js';
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
