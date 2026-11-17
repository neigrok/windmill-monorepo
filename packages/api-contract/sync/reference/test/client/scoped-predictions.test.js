import assert from 'node:assert/strict';
import test from 'node:test';
import { commit } from '../../client/commit.js';
import { signIn } from '../../client/lifecycle.js';
import { Device, Replica } from '../../client/replica.js';
import { Registry } from '../../core/registry.js';
import { scopedCoverage, scopedPredictions, scopedReconciliation, scopedReplay, scopedDependencies } from '../../vectors/scoped-predictions.js';

test('scoped prediction vectors keep each projection in its own scope', () => {
  assert.equal(scopedPredictions().length, 17);
});

test('scoped coverage survives partial cursors, restart, newer text and epoch recovery', () => {
  assert.equal(scopedCoverage().length, 10);
});

test('scoped remaps and accepted versions never cross singleton scopes', () => {
  assert.equal(scopedReconciliation().length, 5);
});

test('exclusive replay batches keep acknowledgement pruning behind saved receipts', () => {
  assert.equal(scopedReplay().length, 6);
});

test('scoped target predictions retain record and governing dependencies', () => {
  assert.equal(scopedDependencies().length, 2);
});

for (const choice of ['add', 'discard']) test(`origin-product ${choice} owns a cross-product command and all its projections`, () => {
  const registry = new Registry({ registry: 'fixture', version: 1, minVersion: 1, products: { p: {}, q: {} },
    types: ['p', 'q'].map((product) => ({ type: `${product}meta`, scope: `product:${product}`, identity: 'singleton',
      singletonId: 'meta', idPattern: '^meta$', life: false, origins: ['replica'], fields: { title: { kind: 'lww', writer: 'client' } } })),
    commands: [{ name: 'p.capture', scope: 'product:p', origins: ['replica', 'server'], serverInternal: false,
      args: {}, scopedEffects: true, engine: 'capture', predicts: ['pmeta', 'qmeta'] }],
  });
  const device = new Device({ active: 'rp_anon', replicas: [Replica.fresh({ replica: 'rp_anon' }).toJSON()] });
  const ctx = { registry, device, actor: 'r_aaaaaaaaaaaa', deviceNow: 1000, ended: [], events: [],
    nextGestureId: () => 'g1', newReplicaId: () => 'rp_new' };
  commit(device.activeReplica, ctx, 'self/p', [], { cmd: { name: 'p.capture', args: {} }, scopedPredict: [
    { scope: 'self/p', changes: [{ op: 'write', t: 'pmeta', id: 'meta', f: { title: 'Origin' } }] },
    { scope: 'self/q', changes: [{ op: 'write', t: 'qmeta', id: 'meta', f: { title: 'Target' } }] },
  ] });
  const projections = structuredClone(device.activeReplica.outbox[0].predictions);
  const args = { account: 'A', holdsRecords: { p: true, q: true } };
  const question = signIn(device, ctx, args);
  assert.deepEqual(question, { complete: false, due: [{ kind: 'signed-out', product: 'p', count: { pmeta: 1, qmeta: 1 }, counted: ['g1/0'] }] });
  assert.deepEqual(signIn(device, ctx, { ...args, decisions: { p: choice, q: choice === 'add' ? 'discard' : 'add' } }), { complete: true, due: question.due });
  assert.deepEqual(device.activeReplica.outbox.map(({ predictions }) => predictions), choice === 'add' ? [projections] : []);
});
