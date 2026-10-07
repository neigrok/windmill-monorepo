import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { signIn } from '../../client/lifecycle.js';
import { Device, Replica } from '../../client/replica.js';
import { jcs } from '../../core/jcs.js';
import { registry } from '../../vectors/fixtures.js';

const hashText = (value) => createHash('sha256').update(value).digest('hex');

function setup(kept) {
  const anon = Replica.fresh({ replica: 'rp_anon' });
  anon.device.probe = { rack: { body: 'anonymous writing' } };
  const dormant = Replica.fresh({ replica: 'rp_kept', state: 'dormant', account: 'A' });
  dormant.device.probe = { rack: { body: 'account writing' } };
  const device = new Device({ active: anon.id, replicas: [anon.toJSON(), ...(kept ? [dormant.toJSON()] : [])] });
  const ctx = { registry, ended: [], events: [], newReplicaId: () => 'rp_new',
    pendingDeviceWork: (product, rows) => product === 'probe' ? Object.keys(rows) : [],
    adoptDeviceRows: (product, incoming, current) => product === 'probe'
      ? { ...incoming, ...current, ...(current.rack ? { 'picture:incoming': incoming.rack } : {}) } : undefined };
  return { device, ctx };
}

for (const kept of [false, true]) test(`device-only work adopts into ${kept ? 'a dormant' : 'an empty'} account without losing writing`, () => {
  const { device, ctx } = setup(kept);
  assert.deepEqual(signIn(device, ctx, { account: 'A', holdsRecords: { probe: false } }), { complete: true, due: [] });
  assert.deepEqual(device.activeReplica.device.probe, kept
    ? { rack: { body: 'account writing' }, 'picture:incoming': { body: 'anonymous writing' } }
    : { rack: { body: 'anonymous writing' } });
  assert.equal(device.replicas.length, 1);
});

test('a differing pending draft collision cannot adopt without its product merge hook', () => {
  const { device, ctx } = setup(true);
  delete ctx.adoptDeviceRows;
  assert.throws(() => signIn(device, ctx, { account: 'A', holdsRecords: { probe: false } }), /device-work-adoption-conflict/);
});

for (const choice of ['add', 'discard']) test(`device-only work pins its bytes before ${choice}`, () => {
  const { device, ctx } = setup(false);
  const args = { account: 'A', holdsRecords: { probe: true } };
  const question = signIn(device, ctx, args);
  assert.deepEqual(question, { complete: false, due: [{ kind: 'signed-out', product: 'probe', count: {}, pending: 1,
    counted: [`device:probe:rack:${hashText(jcs({ body: 'anonymous writing' }))}`] }] });
  const before = structuredClone(device.toJSON());
  assert.deepEqual(signIn(device, ctx, args), question);
  assert.deepEqual(device.toJSON(), before);
  device.activeReplica.device.probe.rack.body = 'newer writing';
  const stale = signIn(device, ctx, { ...args, decisions: { probe: choice }, counted: { probe: question.due[0].counted } });
  assert.deepEqual(stale, { complete: false, due: [{ kind: 'signed-out', product: 'probe', count: {}, pending: 1,
    counted: [`device:probe:rack:${hashText(jcs({ body: 'newer writing' }))}`] }] });
  const final = signIn(device, ctx, { ...args, decisions: { probe: choice }, counted: { probe: stale.due[0].counted } });
  assert.deepEqual(final, { complete: true, due: stale.due });
  assert.deepEqual(device.activeReplica.device.probe ?? {}, choice === 'add' ? { rack: { body: 'newer writing' } } : {});
  assert.equal(device.replicas.some((replica) => replica.meta.state === 'anon' && replica.device.probe?.rack), false);
});
