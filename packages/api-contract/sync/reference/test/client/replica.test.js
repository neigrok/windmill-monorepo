import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Device, Replica, freshMeta } from '../../client/replica.js';
import { row, st } from '../../vectors/fixtures.js';

test('a replica round-trips its canonical JSON, sorted and without empty parts', () => {
  const replica = new Replica({
    meta: freshMeta('rp_1', 'bound', 'A'),
    confirmed: {
      'self/probe': [
        row({ t: 'card', id: 'card0002', life: ['alive', st(2)], born: st(2), seq: 2 }),
        row({ t: 'card', id: 'card0001', life: ['alive', st(1)], born: st(1), seq: 1 }),
      ],
      'tree/b_00000001': [],
    },
    device: { probe: {}, other: { b: 2, a: 1 } },
  });
  assert.deepEqual(replica.toJSON(), {
    meta: freshMeta('rp_1', 'bound', 'A'),
    confirmed: {
      'self/probe': [
        { t: 'card', id: 'card0001', life: ['alive', st(1)], born: st(1), seq: 1, rc: 1000, ru: 1000 },
        { t: 'card', id: 'card0002', life: ['alive', st(2)], born: st(2), seq: 2, rc: 2000, ru: 2000 },
      ],
    },
    device: { other: { a: 1, b: 2 } },
  });
  assert.deepEqual(new Replica(replica.toJSON()).toJSON(), replica.toJSON());
});

test('observing stamps raises the clock pair and hlcHigh to the greatest, never lowers them', () => {
  const replica = Replica.fresh({ replica: 'rp_1', state: 'bound', account: 'A' });
  replica.observe([st(500, 2, 'srv'), st(400, 9), st(500, 1, 'zzz')]);
  assert.deepEqual({ hlc: replica.meta.hlc, hlcHigh: replica.meta.hlcHigh }, { hlc: { ms: 500, counter: 2 }, hlcHigh: st(500, 2, 'srv') });
  replica.observe([st(100)]);
  assert.deepEqual({ hlc: replica.meta.hlc, hlcHigh: replica.meta.hlcHigh }, { hlc: { ms: 500, counter: 2 }, hlcHigh: st(500, 2, 'srv') });
});

test('a device keeps its active replica by reference through a change of id', () => {
  const device = new Device({ active: 'rp_1', replicas: [{ meta: freshMeta('rp_1', 'bound', 'A') }, { meta: freshMeta('rp_0', 'anon') }] });
  device.activeReplica.meta.replica = 'rp_9';
  assert.deepEqual(device.toJSON(), { active: 'rp_9', replicas: [{ meta: freshMeta('rp_0', 'anon') }, { meta: freshMeta('rp_9', 'bound', 'A') }] });
});
