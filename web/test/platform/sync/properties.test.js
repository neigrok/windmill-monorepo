import assert from 'node:assert/strict';
import test from 'node:test';
import { Replica } from '../../../src/platform/sync/client/replica.js';
import { commit } from '../../../src/platform/sync/client/commit.js';
import { nextPush } from '../../../src/platform/sync/client/sender.js';
import { latticeOf, compareRecords } from '../../../src/platform/sync/core/rows.js';
import { admit } from '../../../../packages/api-contract/sync/reference/server/admit.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { registry, product, Rng, ACTOR } from './oracle-adapters/fixtures.js';

test('property 4: permutations of admitted one-record browser intents yield equal lattice fields (100 seeds × 30 intents)', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const replica = Replica.fresh({ replica: 'rp_00000000000000000000000000000001', state: 'bound', account: 'A' });
    const ctx = { registry, actor: ACTOR, deviceNow: 1000, ended: [], nextGestureId: () => `g${ctx.deviceNow}` };
    for (let i = 0; i < 30; i++) {
      ctx.deviceNow++;
      commit(replica, ctx, 'self/probe', [{ op: 'put', t: 'day', id: `2026-10-0${1 + i % 5}`, present: true, f: { score: i % 11 } }]);
    }
    const intents = nextPush(replica, ctx).intents;
    const rng = new Rng(seed);
    const permutations = [intents, [...intents].reverse(), [...intents].sort(() => rng.int(3) - 1)];
    const final = permutations.map((order) => {
      let state = ServerState.empty({ epoch: 'ep-1', accounts: { A: { name: 'A' } } });
      for (const intent of order) {
        const out = admit({ state, registry, product, origin: { kind: 'replica', account: 'A', replica: replica.id }, intent, serverNow: 2000 });
        assert.equal(out.result.s, 'ok'); state = out.state;
      }
      return state.rowsOf('acct:A/probe').sort(compareRecords).map((row) => ({ t: row.t, id: row.id, ...latticeOf(row) }));
    });
    assert.deepEqual(final[1], final[0]); assert.deepEqual(final[2], final[0]);
  }
});
