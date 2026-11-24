import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore } from '../../../src/platform/sync/memoryStore.js';

test('each memory store is a device of its own: another reads none of its writes and coordinates under another name, and a reopen is the same device', async () => {
  const one = await MemoryStore.open({ newReplicaId: () => 'rp_00000000000000000000000000000001' });
  const other = await MemoryStore.open({ newReplicaId: () => 'rp_00000000000000000000000000000002' });
  await one.transact((device) => device.activeReplica.putConfirmed('self/probe', { t: 'card', id: 'card0001', seq: 1 }));
  const rows = async (store) => (await store.read()).device.activeReplica.confirmedRows('self/probe');
  assert.deepEqual(await rows(other), []);
  assert.notEqual(one.coordination, other.coordination);
  one.close();
  const restored = await one.reopen();
  assert.deepEqual([restored.coordination, (await restored.read()).device.activeReplica.id, await rows(restored)],
    [one.coordination, 'rp_00000000000000000000000000000001', [{ t: 'card', id: 'card0001', seq: 1 }]]);
});

test('a closed memory store refuses every transaction, and an open one has no rows to clean up', async () => {
  const store = await MemoryStore.open({ newReplicaId: () => 'rp_00000000000000000000000000000001' });
  assert.equal(await store.cleanup(128), 0);
  store.close();
  await assert.rejects(store.read(), /sync store closed/);
  await assert.rejects(store.cleanup(128), /sync store closed/);
});
