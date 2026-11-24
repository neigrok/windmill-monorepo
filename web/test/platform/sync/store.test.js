import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { IndexedDBStore, WriterSlice } from '../../../src/platform/sync/store.js';
import { MemoryStore } from '../../../src/platform/sync/memoryStore.js';
import { commit } from '../../../../packages/api-contract/sync/reference/client/commit.js';
import { reidentify } from '../../../../packages/api-contract/sync/reference/client/lifecycle.js';
import { registry } from './oracle-adapters/fixtures.js';
import { versionOneFixture } from './store-v1.js';

const id = 'rp_00000000000000000000000000000001';
const context = (device) => ({ registry, device, actor: 'r_aaaaaaaaaaaa', deviceNow: 100,
  nextGestureId: () => 'gesture', ended: [], events: [], newReplicaId: () => 'rp_00000000000000000000000000000002' });
const gesture = (device) => commit(device.activeReplica, context(device), 'self/probe',
  [{ op: 'create', t: 'card', id: 'card0001', f: { title: 'private words' } }], { hold: true });

// The engine's store interface, which both stores keep: IndexedDB's, and the one held in memory. A second connection is a
// `reopen` of the first, as another tab of IndexedDB's or a restored page of the memory store's opens it.
for (const [kind, open] of [
  ['IndexedDB', () => IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB: new IDBFactory(), newReplicaId: () => id })],
  ['memory', () => MemoryStore.open({ newReplicaId: () => id })],
]) {
  test(`${kind}: concurrent read-and-commit transactions cannot overwrite each other`, async () => {
    const first = await open();
    const stores = [first, await first.reopen()];
    await Promise.all(stores.map((store, index) => store.transact((device) => {
      const rows = device.activeReplica.deviceRows('probe');
      rows.rack = (rows.rack ?? 0) + 1;
      commit(device.activeReplica, { ...context(device), nextGestureId: () => `g${index}` }, 'self/probe',
        [{ op: 'create', t: 'card', id: `card000${index}`, f: { title: 'private words' } }]);
    })));
    const { device } = await stores[0].read();
    assert.equal(device.activeReplica.deviceRows('probe').rack, 2);
    assert.deepEqual(device.activeReplica.entries().map((entry) => entry.commitOrder), [1, 2]);
    stores.forEach((store) => store.close());
  });

  test(`${kind}: a write edits only copies the store owns: a value handed in, an aborted edit or a swapped object never reaches the next write`, async () => {
    const store = await open();
    const held = { label: 'kept' };
    await store.transact((device) => {
      gesture(device);
      device.activeReplica.deviceRows('probe').rack = held;
    });
    held.label = 'edited after the commit';
    const rack = (device) => device.activeReplica.deviceRows('probe').rack;
    assert.deepEqual(await store.transact((device) => structuredClone(rack(device))).then(({ result }) => result), { label: 'kept' });
    await assert.rejects(store.transact((device) => {
      device.activeReplica.outbox[0].state = 'ready';
      rack(device).label = 'aborted';
      throw new Error('abort');
    }));
    await store.transact((device) => {
      const [entry] = device.activeReplica.outbox;
      const original = structuredClone(entry);
      entry.releaseAt = -1;
      device.activeReplica.outbox = [original];
    });
    const { result } = await store.transact((device) => structuredClone({ rack: rack(device), entry: device.activeReplica.outbox[0] }));
    assert.deepEqual(result.rack, { label: 'kept' });
    assert.equal(result.entry.state, 'held');
    assert.notEqual(result.entry.releaseAt, -1);
    store.close();
    const reopened = await store.reopen();
    const { device } = await reopened.read();
    assert.deepEqual([rack(device), device.activeReplica.outbox[0].state, device.activeReplica.outbox[0].releaseAt], [{ label: 'kept' }, 'held', result.entry.releaseAt]);
    reopened.close();
  });

  test(`${kind}: re-identify keeps the replica's handle and its confirmed rows, through a reopen`, async () => {
    const store = await open();
    await store.transact((device) => device.activeReplica.putConfirmed('self/probe',
      { t: 'card', id: 'card0001', seq: 1, rc: 1, ru: 1, life: ['alive', '1:0:srv'], born: '1:0:srv' }));
    const before = await store.read();
    await store.transact((device) => reidentify(device.activeReplica, context(device)));
    store.close();
    const after = await (await store.reopen()).read();
    assert.deepEqual([after.device.activeReplica.storageHandle, after.device.activeReplica.id], [id, 'rp_00000000000000000000000000000002']);
    assert.deepEqual(after.device.activeReplica.confirmed, before.device.activeReplica.confirmed);
  });

  test(`${kind}: throwing or asynchronous transaction callbacks persist nothing`, async () => {
    const store = await open();
    const before = (await store.read()).device.toJSON();
    await assert.rejects(store.transact((device) => { gesture(device); throw new Error('abort'); }));
    await assert.rejects(store.transact(async (device) => { gesture(device); }));
    assert.deepEqual((await store.read()).device.toJSON(), before);
    store.close();
  });

  test(`${kind}: reads share frozen rows, and a write that leaves a scope alone keeps its rows' identity`, async () => {
    const store = await open();
    await store.transact((device) => device.activeReplica.putConfirmed('self/probe', { t: 'card', id: 'card0001', seq: 1 }));
    const rows = (await store.read()).device.activeReplica.confirmed['self/probe'];
    assert.equal(Object.isFrozen(rows) && Object.values(rows).every(Object.isFrozen), true);
    const write = await store.transact((device) => device.activeReplica.putConfirmed('tree/b_00000001', { t: 'tag', id: 'tag00001', seq: 1 }));
    assert.equal(write.changed, true);
    assert.equal((await store.read()).device.activeReplica.confirmed['self/probe'], rows);
    const quiet = await store.transact((device) => device.activeReplica.confirmedRows('self/probe'));
    assert.deepEqual([quiet.changed, quiet.revision], [false, write.revision]);
    store.close();
  });
}

test('an aborted IndexedDB commit restores every row, clock, outbox and device change after reopen', async () => {
  const indexedDB = new IDBFactory();
  let store = await IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB, newReplicaId: () => id });
  const before = (await store.read()).device.toJSON();
  await assert.rejects(store.transact((device) => {
    gesture(device);
    device.activeReplica.deviceRows('probe').rack = { secret: 'private words' };
  }, { beforeCommit: ({ transaction }) => transaction.abort() }));
  store.close();
  store = await IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB, newReplicaId: () => assert.fail('already initialized') });
  assert.deepEqual((await store.read()).device.toJSON(), before);
  await store.transact(gesture);
  const committed = (await store.read()).device.toJSON();
  store.close();
  store = await IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB, newReplicaId: () => assert.fail('already initialized') });
  assert.deepEqual((await store.read()).device.toJSON(), committed);
  assert.equal(committed.replicas[0].outbox[0].state, 'held');
  store.close();
});

test('an IndexedDB write the browser aborts after its callback succeeded, as a full disk does, leaves the next write none of its edits', async () => {
  const store = await IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB: new IDBFactory(), newReplicaId: () => id });
  const rack = (device) => device.activeReplica.deviceRows('probe').rack;
  await store.transact((device) => {
    gesture(device);
    device.activeReplica.deviceRows('probe').rack = { label: 'kept' };
  });
  await assert.rejects(store.transact((device) => {
    device.activeReplica.outbox[0].state = 'ready';
    rack(device).label = 'aborted';
  }, { beforeCommit: ({ transaction }) => transaction.abort() }));
  const { result } = await store.transact((device) => structuredClone({ rack: rack(device), state: device.activeReplica.outbox[0].state }));
  assert.deepEqual(result, { rack: { label: 'kept' }, state: 'held' });
  store.close();
});

test('a store forgets the rows it held of a generation another tab let go', async () => {
  const indexedDB = new IDBFactory();
  const [kept, other] = await Promise.all([1, 2].map(() => IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB, newReplicaId: () => id })));
  await kept.transact((device) => device.activeReplica.putConfirmed('self/probe', { t: 'card', id: 'card0001', seq: 1 }));
  const [generation] = kept.generations.keys();
  assert.equal((await kept.read(['self/probe'])).device.activeReplica.confirmedRows('self/probe').length, 1);
  await other.transact((device) => device.activeReplica.forgetScope('self/probe'));
  assert.deepEqual((await kept.read(['self/probe'])).device.activeReplica.confirmedRows('self/probe'), []);
  assert.equal(kept.generations.has(generation), false);
  [kept, other].forEach((store) => store.close());
});

test('offline storage denial fails explicitly and never replaces durable work with an empty store', async () => {
  await assert.rejects(IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB: null, newReplicaId: () => id }), /unavailable/);
  await assert.rejects(IndexedDBStore.open({ indexedDB: new IDBFactory(), newReplicaId: () => id }), /unavailable/);
});

test('scoped writers read only selected rows; generation swaps and forgets do not rewrite a large cache', async (t) => {
  const indexedDB = new IDBFactory();
  const writer = await IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB, newReplicaId: () => id });
  const row = (n) => ({ t: 'card', id: `card${String(n).padStart(5, '0')}`, seq: 1, rc: 1, ru: 1, born: '1:0:srv', life: ['alive', '1:0:srv'] });
  await writer.transact((device) => {
    for (let n = 0; n < 1024; n++) device.activeReplica.putConfirmed('self/probe', row(n));
    device.activeReplica.putConfirmed('tree/b_00000001', row(0));
  });
  writer.close();
  const store = await IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB, newReplicaId: () => assert.fail('already initialized') });
  const result = await store.transact((device) => {
    assert.equal(device.activeReplica.confirmedRows('self/probe').length, 1);
    assert.equal(device.activeReplica.confirmedRows('tree/b_00000001').length, 0);
    device.activeReplica.putConfirmed('self/probe', { ...row(0), seq: 2 });
  }, { scopes: [{ scope: 'self/probe', keys: ['["card","card00000"]'] }] });
  assert.equal(result.measurement.rowReads, 1);
  assert.equal(result.measurement.rowWrites, 1);
  const again = await store.transact((device) => {
    assert.deepEqual(device.activeReplica.confirmedRows('self/probe'), [{ ...row(0), seq: 2 }]);
  }, { scopes: [{ scope: 'self/probe', keys: ['["card","card00000"]'] }] });
  assert.equal(again.measurement.rowReads, 0);
  assert.equal(again.measurement.rowWrites, 0);
  await store.transact((device) => { device.activeReplica.staging['self/probe'] = { digest: 'replacement', rows: { 'card/card09999': row(9999) } }; });
  const swap = await store.transact((device) => {
    const replica = device.activeReplica;
    replica.confirmed['self/probe'] = replica.staging['self/probe'].rows;
    delete replica.staging['self/probe'];
  });
  assert.equal(swap.measurement.rowReads, 0);
  assert.equal(swap.measurement.rowWrites, 0);
  assert.deepEqual((await store.read(['self/probe'])).device.activeReplica.confirmedRows('self/probe'), [row(9999)]);
  const forgotten = await store.transact((device) => device.activeReplica.forgetScope('self/probe'));
  assert.equal(forgotten.measurement.rowReads, 0);
  assert.equal(forgotten.measurement.rowWrites, 0);
  assert.deepEqual((await store.read()).device.activeReplica.confirmedRows('self/probe'), []);
  assert.equal(await store.cleanup(128), 128);
  assert.equal((await store.read(['tree/b_00000001'])).device.activeReplica.confirmedRows('tree/b_00000001').length, 1);
  let removed = 128;
  for (let batch; (batch = await store.cleanup(128));) { assert.ok(batch <= 128); removed += batch; }
  assert.equal(removed, 1025);
  t.diagnostic(JSON.stringify({ scoped: result.measurement, swap: swap.measurement, forget: forgotten.measurement, cleanupRows: removed }));
  store.close();
});

test('an aborted staging pointer swap leaves both generations usable after reopening', async () => {
  const indexedDB = new IDBFactory();
  let store = await IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB, newReplicaId: () => id });
  await store.transact((device) => {
    device.activeReplica.confirmed['self/probe'] = { old: { t: 'card', id: 'old', seq: 1 } };
    device.activeReplica.staging['self/probe'] = { digest: 'new', rows: { replacement: { t: 'card', id: 'replacement', seq: 2 } } };
  });
  const before = (await store.read()).device.toJSON();
  await assert.rejects(store.transact((device) => {
    device.activeReplica.confirmed['self/probe'] = device.activeReplica.staging['self/probe'].rows;
    delete device.activeReplica.staging['self/probe'];
  }, { beforeCommit: ({ transaction }) => transaction.abort() }));
  store.close(); store = await IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB, newReplicaId: () => assert.fail() });
  assert.deepEqual((await store.read()).device.toJSON(), before);
  assert.equal(await store.cleanup(), 0);
  store.close();
});

test('governing-type index reads omit unrelated product rows and preserve them on commit', async () => {
  const indexedDB = new IDBFactory();
  const writer = await IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB, newReplicaId: () => id });
  await writer.transact((device) => {
    for (let n = 0; n < 100; n++) device.activeReplica.putConfirmed('self/probe', { t: 'card', id: `c${n}`, seq: 1 });
    device.activeReplica.putConfirmed('self/probe', { t: 'board', id: 'b_00000001', seq: 1 });
  });
  writer.close();
  const store = await IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB, newReplicaId: () => assert.fail('already initialized') });
  const answer = await store.transact((device) => {
    assert.deepEqual(device.activeReplica.confirmedRows('self/probe'), [{ t: 'board', id: 'b_00000001', seq: 1 }]);
    device.activeReplica.meta.authPaused = true;
  }, { scopes: [{ scope: 'self/probe', type: 'board' }] });
  assert.equal(answer.measurement.rowReads, 1);
  assert.equal(answer.measurement.rowWrites, 0);
  assert.equal((await store.read(['self/probe'])).device.activeReplica.confirmedRows('self/probe').length, 101);
  store.close();
});

for (const blocked of [false, true]) test(`every version-one row survives ${blocked ? 'an abandoned blocked open, retry' : 'migration'} and a second open`, async () => {
  const indexedDB = new IDBFactory();
  const { records, expected } = versionOneFixture();
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('migration', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const transaction = database.transaction('records', 'readwrite');
    for (const record of records) transaction.objectStore('records').put(record);
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
  if (blocked) {
    let request, abandoned;
    const opening = IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB: { open(name, version) {
      request = indexedDB.open(name, version);
      request.addEventListener('upgradeneeded', () => { abandoned = request.result; });
      return request;
    } }, name: 'migration', newReplicaId: () => assert.fail('existing device must survive') });
    try {
      await assert.rejects(opening, /sync storage blocked/);
      const finished = new Promise((resolve) => {
        request.addEventListener('success', () => resolve('success'));
        request.addEventListener('error', () => resolve(request.error.name));
      });
      database.close();
      assert.equal(await finished, 'AbortError');
      assert.throws(() => abandoned.transaction('records'), { name: 'InvalidStateError' });
      const original = await new Promise((resolve, reject) => {
        const read = indexedDB.open('migration', 1);
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
      });
      try {
        const retained = await new Promise((resolve, reject) => {
          const transaction = original.transaction('records');
          const read = transaction.objectStore('records').getAll();
          transaction.oncomplete = () => resolve(read.result);
          transaction.onabort = () => reject(transaction.error);
        });
        assert.deepEqual(retained, records.toSorted((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      } finally { original.close(); }
    } finally { database.close(); abandoned?.close(); }
  } else database.close();
  for (let opened = 0; opened < 2; opened++) {
    const store = await IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB, name: 'migration', newReplicaId: () => assert.fail('existing device must survive') });
    try {
      assert.equal(store.database.version, 3);
      assert.equal((await store.read([{ scope: 'self/probe', type: 'card' }])).measurement.rowReads, 12);
      assert.deepEqual((await store.read()).device.toJSON(), expected);
    } finally { store.close(); }
  }
});

test('a rejected open closes a late successful connection without initializing it', async () => {
  const indexedDB = new IDBFactory();
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('late-success', 2);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const request = { result: database };
  try {
    const opening = IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB: { open: () => request }, name: 'late-success',
      newReplicaId: () => assert.fail('a rejected open must not initialize storage') });
    request.onblocked();
    await assert.rejects(opening, /sync storage blocked/);
    request.onsuccess();
    assert.throws(() => database.transaction('records'), { name: 'InvalidStateError' });
  } finally { database.close(); }
});

test('versionchange releases every open store so a later upgrade can complete', async () => {
  const indexedDB = new IDBFactory();
  const stores = await Promise.all([1, 2].map(() => IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB, newReplicaId: () => id })));
  let upgraded;
  try {
    upgraded = await new Promise((resolve, reject) => {
      const request = indexedDB.open('wm-sync', 4);
      request.onsuccess = () => { request.result.close(); resolve(request.result); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('open stores did not release their connections'));
    });
    assert.equal(upgraded.version, 4);
    assert.deepEqual(stores.map((store) => store.closed), [true, true]);
    for (const store of stores) await assert.rejects(store.read(), /sync store closed/);
  } finally { stores.forEach((store) => store.close()); }
});

test('a version-two store upgrades to three with every record, its open tab closes, and a version-two open is refused', async () => {
  const indexedDB = new IDBFactory();
  const opened = (name, version, upgrade) => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    if (upgrade) request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const all = (database, name) => new Promise((resolve, reject) => {
    const transaction = database.transaction(name);
    const read = transaction.objectStore(name).getAll();
    transaction.oncomplete = () => resolve(read.result);
    transaction.onabort = () => reject(transaction.error);
  });
  const source = await IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB, name: 'source', newReplicaId: () => id });
  await source.transact(gesture);
  const expected = (await source.read()).device.toJSON();
  const [records, rows] = [await all(source.database, 'records'), await all(source.database, 'rows')];
  source.close();
  const older = await opened('upgrade', 2, (database) => {
    database.createObjectStore('records', { keyPath: 'key' });
    const store = database.createObjectStore('rows', { keyPath: 'key' });
    store.createIndex('generation', 'generation');
    store.createIndex('type', 'type');
  });
  await new Promise((resolve, reject) => {
    const transaction = older.transaction(['records', 'rows'], 'readwrite');
    for (const record of records) transaction.objectStore('records').put(record);
    for (const row of rows) transaction.objectStore('rows').put(row);
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
  let olderClosed = false;
  older.onversionchange = () => { olderClosed = true; older.close(); };
  const store = await IndexedDBStore.open({ keyRange: IDBKeyRange, indexedDB, name: 'upgrade', newReplicaId: () => assert.fail('existing device must survive') });
  try {
    assert.equal(olderClosed, true);
    assert.equal(store.database.version, 3);
    assert.deepEqual((await store.read()).device.toJSON(), expected);
    await assert.rejects(opened('upgrade', 2), { name: 'VersionError' });
  } finally { store.close(); }
});

test('a writer slice doubles while under half the slice, fits the aim past it, and never shrinks below its start', () => {
  const slice = new WriterSlice(64);
  const sizes = [[64, 2], [128, 0], [256, 6.25], [512, 50], [256, 100], [64, 400], [0, 400]].map(([taken, heldMs]) => {
    slice.record(taken, heldMs);
    return slice.size;
  });
  assert.deepEqual(sizes, [128, 256, 512, 128, 64, 64, 64]);
  for (let step = 0; step < 12; step++) slice.record(slice.size, 1);
  assert.equal(slice.size, 4096);
});
