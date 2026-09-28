import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CommitError, commit } from '../../client/commit.js';
import { Device, Replica } from '../../client/replica.js';
import { mintId } from '../../core/derive.js';
import { Registry } from '../../core/registry.js';
import { ACTOR, registry, row, st } from '../../vectors/fixtures.js';
import { runSteps } from '../../vectors/steps.js';

function bound(confirmed = {}) {
  return new Replica({ meta: Replica.fresh({ replica: 'rp_1', state: 'bound', account: 'A' }).meta, confirmed });
}

function ctx(draws = []) {
  const queue = [...draws];
  let gestures = 0;
  return { registry, actor: 'r_aaaaaaaaaaaa', deviceNow: 5000, ended: [], nextGestureId: () => `g${(gestures += 1)}`, draw: () => queue.shift() };
}

const CARD = row({ t: 'card', id: 'card0001', life: ['alive', st(1000)], born: st(1000), f: { title: ['One', st(1000)] }, seq: 1 });

test('§7.1: a read-and-commit body decides its gesture from drawn and stored in the same commit, and its value comes back', () => {
  const replica = bound({ 'self/probe': [CARD] });
  const context = ctx();
  commit(replica, context, 'self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }], { hold: true });
  const seen = [];
  const answer = commit(replica, context, 'self/probe', ({ drawn, stored }) => {
    seen.push([...drawn.values()].map((record) => record.life[0]), [...stored.values()].map((record) => record.life[0]));
    return { gesture: { changes: [{ op: 'create', t: 'card', id: 'card0002', f: { title: `${stored.size} stored` } }], opts: { hold: true } }, value: 'decided' };
  });
  assert.deepEqual(seen, [['dead'], ['alive']]);
  assert.deepEqual(answer, { outcome: { localIds: ['g2/0'], retired: [], stamp: '5000:1:r_aaaaaaaaaaaa' }, value: 'decided' });
  assert.deepEqual(replica.entry('g2/0').intent.d[0].f.title, ['1 stored', '5000:1:r_aaaaaaaaaaaa']);
  assert.equal(replica.entry('g2/0').state, 'held');
});

test('§7.1: a body answering no gesture writes nothing and ticks no clock, and its value still comes back', () => {
  const replica = bound({ 'self/probe': [CARD] });
  const before = replica.toJSON();
  let gestures = 0;
  const context = { ...ctx(), nextGestureId: () => `g${(gestures += 1)}` };
  const answer = commit(replica, context, 'self/probe', ({ drawn }) => ({ gesture: null, value: drawn.size }));
  assert.deepEqual(answer, { outcome: null, value: 1 });
  assert.deepEqual(replica.toJSON(), before);
  assert.equal(gestures, 0);
});

// Every throwing commit of the corpus, run on the replica itself with no step rollback: the throw comes
// before the commit writes anything, the clock included.
test('§7.1: commit throws only before its transaction writes, so a throw leaves the replica as it was', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../../corpus/commit/throws.json', import.meta.url), 'utf8'));
  for (const { name, input } of vectors) {
    const last = input.steps.at(-1);
    const device = new Device(runSteps({ ...input, steps: input.steps.slice(0, -1) }).device);
    const before = device.toJSON();
    const context = { registry, actor: last.actor ?? input.actor ?? ACTOR, deviceNow: last.deviceNow ?? 0, ended: [], device, nextGestureId: () => 'thrown' };
    assert.throws(() => commit(device.activeReplica, context, last.scope, last.changes, last.opts ?? {}), CommitError, name);
    assert.deepEqual(device.toJSON(), before, name);
    assert.deepEqual(context.ended, [], name);
  }
});

test('§7.1: an error the read-and-commit body throws passes through unchanged, and nothing is written', () => {
  const replica = bound({ 'self/probe': [CARD] });
  const before = replica.toJSON();
  const thrown = new RangeError('the product\'s own');
  assert.throws(() => commit(replica, ctx(), 'self/probe', () => {
    throw thrown;
  }), (error) => error === thrown);
  assert.deepEqual(replica.toJSON(), before);
});

test('§7.1: a replica that is not writable and a malformed commit are distinct failures', () => {
  const dormant = new Replica({ meta: Replica.fresh({ replica: 'rp_1', state: 'dormant', account: 'A' }).meta });
  const kindOf = (act) => {
    try {
      act();
    } catch (error) {
      assert.ok(error instanceof CommitError);
      return error.kind;
    }
    return null;
  };
  assert.deepEqual([
    kindOf(() => commit(dormant, ctx(), 'self/probe', [{ op: 'create', t: 'card', id: 'card0001', f: { title: 'One' } }])),
    kindOf(() => commit(bound(), ctx(), 'self/probe', [{ op: 'update', t: 'card', id: 'card0404', f: { title: 'Absent' } }])),
  ], ['not-writable', 'malformed']);
});

test('§7.1 step 4: a command\'s arguments round to their domain\'s quantum at any depth', () => {
  const gym = Registry.fromFile(fileURLToPath(new URL('../../../gym.registry.json', import.meta.url)));
  const replica = new Replica({ meta: Replica.fresh({ replica: 'rp_1', state: 'bound', account: 'A' }).meta });
  const set = (weightKg, rpe) => ({ id: 'set0000000000001', exerciseId: 'dip', weightKg, reps: 5, rpe, completedAt: 1500 });
  const context = { ...ctx(), registry: gym, device: new Device({ active: 'rp_1', replicas: [replica.toJSON()] }) };
  commit(replica, context, 'self/gym', [], { cmd: { name: 'gym.importSession', args: { id: 'sess000000000001', startedAt: 1000, finishedAt: 2000, sets: [set(60.004, 7.25)] } } });
  assert.deepEqual(replica.entry('g1/0').intent.cmd.args.sets, [set(60, 7.3)]);
});

test('D-8: a minted id is the prefix and one alphabet character per draw', () => {
  const board = registry.type('board');
  const draws = [3, 15, 10, 9, 12, 1, 14, 0];
  assert.equal(mintId(board, () => draws.shift()), 'b_3fa9c1e0');
  assert.throws(() => mintId(board, () => 16), /outside 0..15/);
});

test('§7.1 step 5: a create without an id mints one and draws again while it is taken', () => {
  const taken = row({ t: 'card', id: '0000000000000000', life: ['alive', st(1000)], born: st(1000), f: { title: ['Taken', st(1000)] }, seq: 1 });
  const replica = bound({ 'self/probe': [taken] });
  commit(replica, ctx([...Array(16).fill(0), ...Array(15).fill(0), 1]), 'self/probe', [{ op: 'create', t: 'card', f: { title: 'New' } }]);
  assert.equal(replica.entry('g1/0').intent.d[0].id, '0000000000000001');
});
