import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDBStore } from '../../../src/platform/sync/store.js';
import { commit } from '../../../src/platform/sync/client/commit.js';
import { reidentify } from '../../../src/platform/sync/client/lifecycle.js';
import { registry } from './oracle-adapters/fixtures.js';
import { versionOneFixture } from './store-v1.js';

const id = 'rp_00000000000000000000000000000001';
const context = (device) => ({ registry, device, actor: 'r_aaaaaaaaaaaa', deviceNow: 100,
  nextGestureId: () => 'gesture', ended: [], events: [], newReplicaId: () => 'rp_00000000000000000000000000000002' });
const gesture = (device) => commit(device.activeReplica, context(device), 'self/probe',
  [{ op: 'create', t: 'card', id: 'card0001', f: { title: 'private words' } }], { hold: true });

test('an aborted IndexedDB commit restores every row, clock, outbox and device change after reopen', async () => {
  const indexedDB = new IDBFactory();
  let store = await IndexedDBStore.open({ indexedDB, newReplicaId: () => id });
  const before = (await store.read()).device.toJSON();
  await assert.rejects(store.transact((device) => {
    gesture(device);
    device.activeReplica.deviceRows('probe').rack = { secret: 'private words' };
  }, { beforeCommit: ({ transaction }) => transaction.abort() }));
  store.close();
  store = await IndexedDBStore.open({ indexedDB, newReplicaId: () => assert.fail('already initialized') });
  assert.deepEqual((await store.read()).device.toJSON(), before);
  await store.transact(gesture);
  const committed = (await store.read()).device.toJSON();
  store.close();
  store = await IndexedDBStore.open({ indexedDB, newReplicaId: () => assert.fail('already initialized') });
  assert.deepEqual((await store.read()).device.toJSON(), committed);
  assert.equal(committed.replicas[0].outbox[0].state, 'held');
  store.close();
});

test('concurrent tab read-and-commit transactions cannot overwrite each other', async () => {
  const indexedDB = new IDBFactory();
  const stores = await Promise.all([1, 2].map(() => IndexedDBStore.open({ indexedDB, newReplicaId: () => id })));
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

test('re-identify persists new metadata without changing confirmed row keys or bytes', async () => {
  const store = await IndexedDBStore.open({ indexedDB: new IDBFactory(), newReplicaId: () => id });
  await store.transact((device) => device.activeReplica.putConfirmed('self/probe',
    { t: 'card', id: 'card0001', seq: 1, rc: 1, ru: 1, life: ['alive', '1:0:srv'], born: '1:0:srv' }));
  const before = await store.read();
  let changes;
  await store.transact((device) => reidentify(device.activeReplica, context(device)), { beforeCommit: ({ records }) => { changes = records; } });
  const after = await store.read();
  assert.equal(after.device.activeReplica.storageHandle, before.device.activeReplica.storageHandle);
  assert.deepEqual(after.device.activeReplica.confirmed, before.device.activeReplica.confirmed);
  assert.equal(after.device.activeReplica.id, 'rp_00000000000000000000000000000002');
  assert.ok([...changes.keys()].some((key) => key.includes('confirmed') && key.includes(id)));
  store.close();
});

test('throwing or asynchronous transaction callbacks persist nothing', async () => {
  const store = await IndexedDBStore.open({ indexedDB: new IDBFactory(), newReplicaId: () => id });
  const before = (await store.read()).device.toJSON();
  await assert.rejects(store.transact((device) => { gesture(device); throw new Error('abort'); }));
  await assert.rejects(store.transact(async (device) => { gesture(device); }));
  assert.deepEqual((await store.read()).device.toJSON(), before);
  store.close();
});

test('offline storage denial fails explicitly and never replaces durable work with an empty store', async () => {
  await assert.rejects(IndexedDBStore.open({ indexedDB: null, newReplicaId: () => id }), /unavailable/);
});

test('scoped writers read only selected rows; generation swaps and forgets do not rewrite a large cache', async (t) => {
  const store = await IndexedDBStore.open({ indexedDB: new IDBFactory(), newReplicaId: () => id });
  const row = (n) => ({ t: 'card', id: `card${String(n).padStart(5, '0')}`, seq: 1, rc: 1, ru: 1, born: '1:0:srv', life: ['alive', '1:0:srv'] });
  await store.transact((device) => {
    for (let n = 0; n < 1024; n++) device.activeReplica.putConfirmed('self/probe', row(n));
    device.activeReplica.putConfirmed('tree/b_00000001', row(0));
  });
  const result = await store.transact((device) => {
    assert.equal(device.activeReplica.confirmedRows('self/probe').length, 1);
    assert.equal(device.activeReplica.confirmedRows('tree/b_00000001').length, 0);
    device.activeReplica.confirmedRows('self/probe')[0].seq++;
  }, { scopes: [{ scope: 'self/probe', keys: ['["card","card00000"]'] }] });
  assert.equal(result.measurement.rowReads, 1);
  assert.equal(result.measurement.rowWrites, 1);
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
  let store = await IndexedDBStore.open({ indexedDB, newReplicaId: () => id });
  await store.transact((device) => {
    device.activeReplica.confirmed['self/probe'] = { old: { t: 'card', id: 'old', seq: 1 } };
    device.activeReplica.staging['self/probe'] = { digest: 'new', rows: { replacement: { t: 'card', id: 'replacement', seq: 2 } } };
  });
  const before = (await store.read()).device.toJSON();
  await assert.rejects(store.transact((device) => {
    device.activeReplica.confirmed['self/probe'] = device.activeReplica.staging['self/probe'].rows;
    delete device.activeReplica.staging['self/probe'];
  }, { beforeCommit: ({ transaction }) => transaction.abort() }));
  store.close(); store = await IndexedDBStore.open({ indexedDB, newReplicaId: () => assert.fail() });
  assert.deepEqual((await store.read()).device.toJSON(), before);
  assert.equal(await store.cleanup(), 0);
  store.close();
});

test('governing-type index reads omit unrelated product rows and preserve them on commit', async () => {
  const store = await IndexedDBStore.open({ indexedDB: new IDBFactory(), newReplicaId: () => id });
  await store.transact((device) => {
    for (let n = 0; n < 100; n++) device.activeReplica.putConfirmed('self/probe', { t: 'card', id: `c${n}`, seq: 1 });
    device.activeReplica.putConfirmed('self/probe', { t: 'board', id: 'b_00000001', seq: 1 });
  });
  const answer = await store.transact((device) => {
    assert.deepEqual(device.activeReplica.confirmedRows('self/probe'), [{ t: 'board', id: 'b_00000001', seq: 1 }]);
    device.activeReplica.meta.authPaused = true;
  }, { scopes: [{ scope: 'self/probe', type: 'board' }] });
  assert.equal(answer.measurement.rowReads, 1);
  assert.equal(answer.measurement.rowWrites, 0);
  assert.equal((await store.read(['self/probe'])).device.activeReplica.confirmedRows('self/probe').length, 101);
  store.close();
});

test('every version-one row survives migration and a second open', async () => {
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
  database.close();
  for (let opened = 0; opened < 2; opened++) {
    const store = await IndexedDBStore.open({ indexedDB, name: 'migration', newReplicaId: () => assert.fail('existing device must survive') });
    try {
      assert.equal(store.database.version, 2);
      assert.deepEqual((await store.read()).device.toJSON(), expected);
      assert.equal((await store.read([{ scope: 'self/probe', type: 'card' }])).measurement.rowReads, 12);
    } finally { store.close(); }
  }
});
