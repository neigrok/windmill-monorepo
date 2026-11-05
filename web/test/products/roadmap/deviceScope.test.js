import test from 'node:test';
import assert from 'node:assert/strict';

import { LocalTreeRegistry, confirmDeviceOwner, deviceOwner } from '../../../src/products/roadmap/persistence/LocalTreeRegistry.js';
import { listAllTrees } from '../../../src/products/roadmap/persistence/TreeRegistry.js';
import { loadDeviceTree, forgetDeviceTrees } from '../../../src/products/roadmap/sync/localTrees.js';
import { SyncStore } from '../../../src/products/roadmap/sync/SyncStore.js';
import { WorkspaceStore } from '../../../src/products/roadmap/persistence/WorkspaceStore.js';
import { ProgressStore } from '../../../src/products/roadmap/persistence/ProgressStore.js';
import { TreeLattice, HlcClock } from '../../../src/products/roadmap/sync/lattice.js';
import { materialize } from '../../../src/products/roadmap/sync/materialize.js';
import { roadmapRoutes } from '../../../src/products/roadmap/routes.js';
import { syncSession } from '../../../src/platform/sync/session.js';

const BASE = 'http://localhost:8088';
const INDEX = 'windmill:device-trees';

const realFetch = globalThis.fetch;
const realWindow = globalThis.window;
const realLocalStorage = globalThis.localStorage;
const realIndexedDB = globalThis.indexedDB;

function browser({ index = {}, keys = {}, blobs = {}, hash = '' } = {}) {
  const disk = new Map(Object.entries(keys));
  disk.set(INDEX, JSON.stringify(index));
  const storage = {
    getItem: (key) => (disk.has(key) ? disk.get(key) : null),
    setItem: (key, value) => { disk.set(key, String(value)); },
    removeItem: (key) => { disk.delete(key); },
  };
  // Per-tree stores enumerate residue with Object.keys over Storage, so keys must live on the object.
  const storageView = new Proxy(storage, {
    ownKeys: () => [...disk.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    get: (target, prop) => (typeof prop === 'string' && disk.has(prop) && !(prop in target) ? disk.get(prop) : target[prop]),
  });
  const records = new Map(Object.entries(blobs));
  globalThis.window = { localStorage: storageView, location: { hash }, dispatchEvent: () => true, setTimeout: () => 0 };
  globalThis.localStorage = storageView;
  globalThis.indexedDB = fakeIndexedDB(records);
  return {
    index: () => JSON.parse(disk.get(INDEX)),
    keys: () => [...disk.keys()].sort(),
    blobIds: () => [...records.keys()].sort(),
  };
}

// Enough of IndexedDB for SyncStore: one database, one store, the four requests it issues.
function fakeIndexedDB(records) {
  const settle = (request, result) => {
    queueMicrotask(() => { request.result = result; request.onsuccess?.(); });
    return request;
  };
  const objectStore = () => ({
    get: (key) => settle({}, records.get(key)),
    getAllKeys: () => settle({}, [...records.keys()]),
    put: (value, key) => { records.set(key, value); return settle({}, undefined); },
    delete: (key) => { records.delete(key); return settle({}, undefined); },
  });
  return {
    open: () => {
      const request = {};
      queueMicrotask(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => {
            const txn = { objectStore };
            queueMicrotask(() => queueMicrotask(() => txn.oncomplete?.()));
            return txn;
          },
        };
        request.onsuccess?.();
      });
      return request;
    },
  };
}

// A real lattice frame, so the blob under test is the same shape a live session persists.
function blobFor(treeId, title, label) {
  const lattice = new TreeLattice(treeId, title);
  const clock = new HlcClock('a_test');
  lattice.join(materialize({ kind: 'CreateNode', id: 'n1', label, icon: 'sparkles', color: 'terracotta', x: 0, y: 0 }, lattice, clock));
  return { frame: lattice.toFrame(), lastSeq: 0 };
}

function serverUnreachable() {
  globalThis.fetch = async () => { throw new TypeError('failed to fetch'); };
}

function serverSaying({ me = null, trees = null } = {}) {
  globalThis.fetch = async (url) => {
    if (url === `${BASE}/v1/me`) return me ? { ok: true, status: 200, json: async () => ({ user: { id: me } }) } : { ok: false, status: 401 };
    if (url === `${BASE}/v1/trees`) return trees ? { ok: true, status: 200, json: async () => ({ trees }) } : { ok: false, status: 401 };
    throw new Error(`unexpected request ${url}`);
  };
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.window = realWindow;
  globalThis.localStorage = realLocalStorage;
  globalThis.indexedDB = realIndexedDB;
});

const A_PRIVATE = { title: 'A private therapy plan', updatedAt: 30, claimed: true, owner: 'u_a' };
const ANON = { title: 'Learn to sail', updatedAt: 20, claimed: false, owner: null };

test("a ghost lists only this device's anonymous work — the signed-out account's rows are gone from the union", async () => {
  browser({ index: { t_a: A_PRIVATE, t_anon: ANON } });
  serverSaying({});

  const trees = await listAllTrees();

  assert.deepEqual(trees, [{ id: 't_anon', title: 'Learn to sail', updatedAt: 20, claimed: false, origin: 'device' }]);
  assert.equal(deviceOwner(), null, 'a 401 from /v1/me is the server saying nobody holds this device');
});

test("a different account lists its own trees and the anonymous one, never the previous account's", async () => {
  browser({ index: { t_a: A_PRIVATE, t_anon: ANON } });
  serverSaying({ me: 'u_b', trees: [{ id: 't_b', title: "B's roadmap", updatedAt: 40 }] });

  const trees = await listAllTrees();

  assert.deepEqual(trees.map((tree) => [tree.id, tree.origin]), [['t_b', 'server'], ['t_anon', 'device']]);
  assert.equal(deviceOwner(), 'u_b');
});

test('the owner comes back and finds their own row again — scoping is not a one-way door', async () => {
  browser({ index: { t_a: A_PRIVATE, t_anon: ANON } });
  serverSaying({ me: 'u_a', trees: [{ id: 't_a', title: 'A private therapy plan', updatedAt: 30 }] });

  const trees = await listAllTrees();

  assert.deepEqual(trees.map((tree) => [tree.id, tree.origin]), [['t_a', 'server'], ['t_anon', 'device']]);
});

test('unstamped rows are attributed on first contact — the signed-in account gets them, and they were invisible until then', async () => {
  const device = browser({
    index: { t_old: { title: 'Older than the stamp', updatedAt: 10, claimed: false }, t_synced: { title: 'Synced before the stamp', updatedAt: 5, claimed: true } },
  });
  serverSaying({ me: 'u_a', trees: [{ id: 't_synced', title: 'Synced before the stamp', updatedAt: 5 }] });

  const trees = await listAllTrees();

  assert.deepEqual(trees.map((tree) => [tree.id, tree.origin]), [['t_old', 'device'], ['t_synced', 'server']]);
  assert.deepEqual(device.index(), {
    t_old: { title: 'Older than the stamp', updatedAt: 10, claimed: false, owner: 'u_a' },
    t_synced: { title: 'Synced before the stamp', updatedAt: 5, claimed: true, owner: 'u_a' },
  });
});

test("an unstamped row is nobody's until a confirmed answer says so — it lists, loads and claims for no one", async () => {
  const device = browser({
    index: { t_legacy: { title: 'A LEGACY UNCLAIMED SECRET', updatedAt: 10, claimed: false } },
    blobs: { t_legacy: blobFor('t_legacy', 'A LEGACY UNCLAIMED SECRET', 'the secret step') },
  });
  const registry = new LocalTreeRegistry();

  assert.deepEqual(registry.list('u_b'), [], 'no account may see an unattributed row');
  assert.deepEqual(registry.list(null), [], 'and neither may a ghost');
  assert.deepEqual(device.index().t_legacy.owner, undefined, 'reading is not attributing');
});

test('the first confirmed answer on a signed-out device makes unstamped rows anonymous, and the claim door stays open', async () => {
  const device = browser({ index: { t_legacy: { title: 'Older than the stamp', updatedAt: 10, claimed: false } } });
  serverSaying({});

  const trees = await listAllTrees();

  assert.deepEqual(trees.map((tree) => tree.id), ['t_legacy']);
  assert.deepEqual(device.index(), { t_legacy: { title: 'Older than the stamp', updatedAt: 10, claimed: false, owner: null } });
});

test("typing another account's tree id paints nothing — the blob answers only for the account that owns the row", async () => {
  browser({ index: { t_a: A_PRIVATE }, blobs: { t_a: blobFor('t_a', 'A private therapy plan', 'call the clinic Tuesday') } });
  serverSaying({ me: 'u_b', trees: [] });

  assert.equal(await loadDeviceTree('t_a'), null);
});

test('a ghost gets nothing from the blob either — not even the tree the browser was last standing in', async () => {
  browser({ index: { t_a: A_PRIVATE }, blobs: { t_a: blobFor('t_a', 'A private therapy plan', 'call the clinic Tuesday') } });
  serverSaying({});

  assert.equal(await loadDeviceTree('t_a'), null);
});

test("the owner offline still opens their own tree from the blob, and an anonymous tree opens for anyone on the device", async () => {
  browser({
    index: { t_a: A_PRIVATE, t_anon: ANON },
    blobs: { t_a: blobFor('t_a', 'A private therapy plan', 'call the clinic Tuesday'), t_anon: blobFor('t_anon', 'Learn to sail', 'rig the boat') },
  });
  serverSaying({ me: 'u_a' });

  const mine = await loadDeviceTree('t_a');
  assert.equal(mine.title, 'A private therapy plan');
  assert.equal(mine.mine, true);
  assert.deepEqual(mine.nodes.map((node) => node.label), ['call the clinic Tuesday']);

  serverSaying({});
  const anonymous = await loadDeviceTree('t_anon');
  assert.equal(anonymous.title, 'Learn to sail');
  assert.equal(anonymous.mine, true);
});

test('offline, the shell answering from its restored replica opens the owner\'s tree on the first read, with no Try again', async () => {
  browser({ index: { t_a: A_PRIVATE }, blobs: { t_a: blobFor('t_a', 'A private therapy plan', 'call the clinic Tuesday') } });
  serverUnreachable();

  const opening = loadDeviceTree('t_a');
  setTimeout(() => confirmDeviceOwner('u_a'), 20);

  assert.equal((await opening).title, 'A private therapy plan');
});

test('forgetDevice drops the departing account and every trace of its trees, and keeps the anonymous one', async () => {
  const device = browser({
    index: { t_a: A_PRIVATE, t_anon: ANON },
    hash: '#/app/t_a',
    keys: {
      'windmill:workspace:t_a': JSON.stringify({ n1: { note: 'call the clinic Tuesday' } }),
      'windmill:progress:t_a': JSON.stringify({ completed: ['n1'], inProgress: [] }),
      'windmill:legend:t_a': JSON.stringify({ kinds: [], open: true }),
      'windmill:return:t_a': JSON.stringify({ completed: ['n1'], at: 1 }),
      'windmill:workspace:t_anon': JSON.stringify({ n1: { note: 'rig the boat' } }),
      'windmill:workspace:t_orphan': JSON.stringify({ n1: { note: 'a tree the index forgot' } }),
      'windmill:last-place': JSON.stringify({ treeId: 't_a', camera: null, selectedId: null, at: 1 }),
    },
    blobs: { t_a: blobFor('t_a', 'A private therapy plan', 'call the clinic Tuesday'), t_anon: blobFor('t_anon', 'Learn to sail', 'rig the boat'), t_orphan: blobFor('t_orphan', 'Forgotten', 'x') },
  });

  await roadmapRoutes.forgetDevice({ previous: 'u_a', next: null });

  assert.deepEqual(device.index(), { t_anon: ANON });
  assert.deepEqual(device.blobIds(), ['t_anon']);
  assert.deepEqual(device.keys(), ['windmill:device-trees', 'windmill:workspace:t_anon']);
  assert.equal(deviceOwner(), null);
  assert.equal(new WorkspaceStore().load('t_a'), null);
  assert.deepEqual(new ProgressStore().treeIds(), [], 'pre-lane progress residue is swept too');
  assert.equal(globalThis.window.location.hash, '#/app', 'the tab must stop painting the tree it just dropped');
  assert.equal(new LocalTreeRegistry().get('t_anon')?.title, 'Learn to sail', 'anonymous work is still here to be claimed');
});

test('forgetDevice on an account switch stamps the arriving account and leaves it nothing to inherit', async () => {
  const device = browser({ index: { t_a: A_PRIVATE, t_anon: ANON }, hash: '#/app/t_a', blobs: { t_a: blobFor('t_a', 'A private therapy plan', 'call the clinic Tuesday') } });

  await roadmapRoutes.forgetDevice({ previous: 'u_a', next: 'u_b' });

  assert.equal(deviceOwner(), 'u_b');
  assert.deepEqual(device.index(), { t_anon: ANON });
  assert.deepEqual(device.blobIds(), []);
});

// A remembered face alone cannot open a device store without a server answer or a restored bound replica.
test('a cold boot with no network is nobody — the account\'s own rows stay shut, anonymous work still opens', async () => {
  browser({
    index: { t_a: A_PRIVATE, t_anon: ANON },
    blobs: { t_a: blobFor('t_a', 'A private therapy plan', 'call the clinic Tuesday'), t_anon: blobFor('t_anon', 'Learn to sail', 'rig the boat') },
  });
  serverUnreachable();

  assert.deepEqual((await listAllTrees()).map((tree) => tree.id), ['t_anon']);
  assert.equal(await loadDeviceTree('t_a'), null);
  assert.equal((await loadDeviceTree('t_anon')).title, 'Learn to sail');
  assert.equal(deviceOwner(), null);
});

test('the network coming back hands the owner their trees, and the network dying again does not take them away', async () => {
  browser({ index: { t_a: A_PRIVATE }, blobs: { t_a: blobFor('t_a', 'A private therapy plan', 'call the clinic Tuesday') } });

  serverUnreachable();
  assert.deepEqual(await listAllTrees(), [], 'unconfirmed: nobody');

  serverSaying({ me: 'u_a', trees: [{ id: 't_a', title: 'A private therapy plan', updatedAt: 30 }] });
  assert.deepEqual((await listAllTrees()).map((tree) => [tree.id, tree.origin]), [['t_a', 'server']]);

  serverUnreachable();
  assert.deepEqual((await listAllTrees()).map((tree) => [tree.id, tree.origin]), [['t_a', 'device']], 'a blip after a confirmed answer keeps the account');
  assert.equal((await loadDeviceTree('t_a')).title, 'A private therapy plan');
});

test('a lapse in this confirmed document keeps the same owner’s unsynced tree readable', async () => {
  const saved = blobFor('t_a', 'A private therapy plan', 'unsynced step');
  const device = browser({ index: { t_a: A_PRIVATE, t_anon: ANON }, hash: '#/app/t_a', blobs: { t_a: saved } });
  serverSaying({ me: 'u_a' });
  const before = await loadDeviceTree('t_a');

  serverSaying({});
  assert.deepEqual(await loadDeviceTree('t_a'), before);
  assert.deepEqual((await listAllTrees()).map((tree) => [tree.id, tree.origin]), [['t_a', 'device'], ['t_anon', 'device']]);
  assert.equal(deviceOwner(), 'u_a');
  assert.equal(window.location.hash, '#/app/t_a');
  assert.deepEqual(device.index(), { t_a: A_PRIVATE, t_anon: ANON });
  assert.deepEqual(device.blobIds(), ['t_a']);

  serverSaying({ me: 'u_a' });
  assert.deepEqual(await loadDeviceTree('t_a'), before);
  serverSaying({ me: 'u_b' });
  assert.equal(await loadDeviceTree('t_a'), null);
});

for (const offline of [false, true]) {
  test(`a cold ${offline ? 'offline' : '401'} load waits for its bound replica and opens only that holder's device work`, async (t) => {
    const saved = blobFor('t_a', 'A private therapy plan', 'unsynced step');
    const device = browser({ index: { t_a: A_PRIVATE, t_b: { ...A_PRIVATE, owner: 'u_b' } }, blobs: { t_a: saved, t_b: saved } });
    if (offline) serverUnreachable();
    else serverSaying({});
    const previous = syncSession.opening;
    let opened;
    syncSession.opening = new Promise((resolve) => { opened = resolve; });
    t.after(() => { syncSession.opening = previous; });
    const opening = loadDeviceTree('t_a');
    const engine = { device: { meta: {}, activeReplica: { meta: { state: 'bound', account: 'u_a', authPaused: true } } } };
    opened(engine);
    const result = await opening;
    const lattice = new TreeLattice('t_a', A_PRIVATE.title);
    lattice.join(saved.frame);
    assert.deepEqual(result, { ...lattice.toTreeData(), mine: true });
    assert.equal(deviceOwner(), 'u_a');
    assert.equal(await loadDeviceTree('t_b'), null);
    assert.deepEqual(engine.device.activeReplica.meta, { state: 'bound', account: 'u_a', authPaused: true });
    assert.deepEqual(device.blobIds(), ['t_a', 't_b']);
  });
}

for (const guard of ['anonymous', 'dormant', 'closed', 'signingOut', 'signOut', 'deviceCleanup', 'clearCredential', 'closingAccount', 'explicit sign-out', 'different account']) {
  test(`a restored replica grants no device-read authority during ${guard}`, async (t) => {
    browser({ index: { t_a: A_PRIVATE }, blobs: { t_a: blobFor('t_a', 'A private therapy plan', 'unsynced step') } });
    const engine = { device: { meta: {}, activeReplica: { meta: { state: 'bound', account: 'u_a', authPaused: true } } } };
    if (guard === 'anonymous' || guard === 'dormant') engine.device.activeReplica.meta.state = guard === 'anonymous' ? 'anon' : guard;
    else if (guard === 'closed' || guard === 'signingOut') engine[guard] = true;
    else if (guard === 'explicit sign-out') confirmDeviceOwner(null);
    else if (guard !== 'different account') engine.device.meta[guard] = { previous: 'u_a' };
    serverSaying({ me: guard === 'different account' ? 'u_b' : null });
    const previous = syncSession.opening;
    syncSession.opening = Promise.resolve(engine);
    t.after(() => { syncSession.opening = previous; });
    assert.equal(await loadDeviceTree('t_a'), null);
    assert.equal(deviceOwner(), guard === 'different account' ? 'u_b' : null);
  });
}


test('failed durable cleanup leaves owner stamps and blobs for the next attempt', async (t) => {
  const device = browser({ index: { t_a: A_PRIVATE, t_anon: ANON },
    blobs: { t_a: blobFor('t_a', 'Private', 'private'), t_anon: blobFor('t_anon', 'Anonymous', 'anonymous') } });
  const clear = SyncStore.prototype.clear;
  t.mock.method(SyncStore.prototype, 'clear', async function (id, options) {
    assert.deepEqual(options, { durable: true });
    if (id === 't_a') throw new Error('cleanup-write-failed');
    return clear.call(this, id, options);
  });
  await assert.rejects(forgetDeviceTrees(), /cleanup-write-failed/);
  assert.deepEqual(device.index(), { t_a: A_PRIVATE, t_anon: ANON });
  assert.deepEqual(device.blobIds(), ['t_a', 't_anon']);
  SyncStore.prototype.clear.mock.restore();
  await forgetDeviceTrees();
  assert.deepEqual(device.index(), { t_anon: ANON });
  assert.deepEqual(device.blobIds(), ['t_anon']);
});
