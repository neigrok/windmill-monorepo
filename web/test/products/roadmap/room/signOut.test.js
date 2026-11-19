// Signing out takes the room's landing notes from every replica the device holds, Keep's dormant one included, and the
// ids of the notices this browser told the intake of.

import test from 'node:test';
import assert from 'node:assert/strict';
import { hello } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { environment } from '../../../platform/sync/fakes.js';
import { browserWith } from '../../gym/harness.mjs';

const note = { nodes: ['n2'], edges: [['n1', 'n2']], revived: [], names: [{ id: 'n1', name: 'Read the wind' }] };

// Every roadmap device row the device's store holds, in every replica, by replica state.
async function rowsOf(engine) {
  const { device } = await engine.store.read();
  return device.replicas.map((replica) => [replica.meta.state, replica.device.roadmap ?? {}]);
}

for (const choice of ['keep', 'discard']) {
  test(`signing out with ${choice === 'keep' ? 'Keep' : 'Discard'} leaves no landing note and no told notice on the device`, async () => {
    browserWith();
    const { forgetReplicaRoom } = await import('../../../../src/products/roadmap/room/signOut.js');
    const env = environment();
    const at = { wall: env.timers.time, mono: env.timers.time, boot: 'test' };
    env.transport.response = async () => ({ response: hello({ state: env.state, registry, account: 'A', serverTime: env.timers.time }), timing: { send: at, recv: at } });
    const engine = await BrowserSyncEngine.open({ ...env.options, registry });
    try {
      await engine.signIn('A');
      await engine.write(null, (device) => { device.activeReplica.deviceRows('roadmap')['landing:t_0000000000000001'] = note; });
      globalThis.window.localStorage.setItem('windmill:roadmap:kept-told', JSON.stringify(['notice:g1/0']));
      await engine.finishSignOut({ choice });
      await engine.write(null, (device) => { device.activeReplica.deviceRows('roadmap')['landing:t_0000000000000002'] = note; });
      const before = await rowsOf(engine);
      await forgetReplicaRoom(engine);
      assert.deepEqual({ before, after: await rowsOf(engine), told: globalThis.window.localStorage.getItem('windmill:roadmap:kept-told') }, {
        before: choice === 'keep'
          ? [['anon', { 'landing:t_0000000000000002': note }], ['dormant', { 'landing:t_0000000000000001': note }]]
          : [['anon', { 'landing:t_0000000000000002': note }]],
        after: choice === 'keep' ? [['anon', {}], ['dormant', {}]] : [['anon', {}]],
        told: null,
      });
    } finally {
      engine.close();
    }
  });
}
