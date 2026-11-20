import assert from 'node:assert/strict';
import test from 'node:test';
import { commit } from '../../client/commit.js';
import { deltasOf } from '../../client/dependents.js';
import { Device, Replica } from '../../client/replica.js';
import { RecordView, view } from '../../client/views.js';
import { recordKey } from '../../core/rows.js';
import { registry, row, st } from '../../vectors/fixtures.js';
import { World } from '../fuzz/simulator.js';

function sameRecords(replica, registry, scope, label) {
  for (const withHeld of [true, false]) {
    const whole = view(replica, registry, scope, { withHeld });
    const records = new RecordView(replica, registry, scope, { withHeld });
    for (const key of [...whole.keys(), recordKey('meta', 'meta')]) assert.deepEqual(records.get(key), whole.get(key), `${label}: ${scope} ${key}`);
    assert.deepEqual([...records.entries()], [...whole.entries()], `${label}: ${scope}`);
  }
}

test('a record view draws a prediction in the scope it targets, held or not, and none once it is covered', () => {
  const tree = 'tree/b_00000001';
  const replica = new Replica({ meta: Replica.fresh({ replica: 'rp_1', state: 'bound', account: 'A' }).meta, confirmed: {
    'self/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1000)], born: st(1000), seq: 1 })],
    [tree]: [row({ t: 'meta', id: 'meta', f: { title: ['Before', st(1000)] }, seq: 2 })] } });
  const device = new Device({ active: 'rp_1', replicas: [] });
  device.replicas = [replica]; device.activeReplica = replica;
  let gestures = 0;
  const ctx = { registry, device, actor: 'r_aaaaaaaaaaaa', deviceNow: 5000, ended: [], nextGestureId: () => `g${(gestures += 1)}` };
  const branch = (title, hold) => commit(replica, ctx, 'self/probe', [], { hold,
    cmd: { name: 'probe.branch', args: { parent: 'b_00000001', child: 'b_00000002', title } },
    scopedPredict: [{ scope: tree, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title } }] }] });
  branch('Held', true);
  branch('Ready', false);
  for (const scope of ['self/probe', tree]) sameRecords(replica, registry, scope, 'held and ready');
  assert.equal(new RecordView(replica, registry, tree, { withHeld: true }).get(recordKey('meta', 'meta')).f.title[0], 'Ready');
  for (const projection of replica.outbox[1].predictions) projection.covered = true;
  for (const scope of ['self/probe', tree]) sameRecords(replica, registry, scope, 'covered');
});

test('a record view folds each record as the whole view does, with and without excepted deltas, in every replayed state', () => {
  const seen = { comparisons: 0, held: 0, predicted: 0, excepted: 0 };
  for (let seed = 1; seed <= 6; seed += 1) {
    const world = new World({ seed, steps: 120 });
    for (let step = 0; step < world.steps; step += 1) {
      world.step();
      for (const device of world.devices) for (const replica of device.store.replicas) {
        const scopes = new Set([...Object.keys(replica.confirmed),
          ...replica.outbox.flatMap((entry) => [entry.scope, ...(entry.predictions ?? []).map(({ scope }) => scope)])]);
        const except = new Set(replica.outbox.filter((entry, index) => index % 3 === 0).flatMap(deltasOf));
        seen.held += replica.outbox.filter((entry) => entry.state === 'held').length;
        seen.predicted += replica.outbox.filter((entry) => entry.predictions || entry.predict).length;
        seen.excepted += except.size;
        for (const scope of scopes) for (const withHeld of [true, false]) for (const options of [{ withHeld }, { withHeld, except }]) {
          const whole = view(replica, world.registry, scope, options);
          const records = new RecordView(replica, world.registry, scope, options);
          for (const key of [...whole.keys(), recordKey('tag', 'absent'), recordKey('link', ['absent', 'oak'])]) {
            assert.deepEqual(records.get(key), whole.get(key), `seed ${seed}, step ${step}, ${scope}, ${key}`);
            seen.comparisons += 1;
          }
          assert.deepEqual([...records.entries()], [...whole.entries()], `seed ${seed}, step ${step}, ${scope}`);
        }
      }
    }
  }
  for (const [kind, count] of Object.entries(seen)) assert.ok(count > 0, `no replayed state exercised ${kind}`);
});
