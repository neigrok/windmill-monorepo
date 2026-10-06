import { Device, Replica } from '../../../src/platform/sync/client/replica.js';
import { recordKey } from '../../../src/platform/sync/core/rows.js';

export function versionOneFixture() {
  const replicas = [1, 2].map((n) => {
    const replica = Replica.fresh({ replica: `rp_${String(n).padStart(32, '0')}`, state: n === 1 ? 'bound' : 'dormant', account: `account-${n}` });
    const row = (id) => ({ t: 'card', id: `card${n}${id}`, seq: n, rc: n, ru: n, born: '1:0:srv', life: ['alive', '1:0:srv'], f: { title: [`saved ${n}/${id}`, '1:0:srv'] } });
    for (const scope of ['self/probe', 'tree/b_00000001']) {
      replica.confirmed[scope] = Object.fromEntries([row('a'), row('b')].map((value) => [recordKey(value.t, value.id), value]));
      replica.spentIds[scope] = Object.fromEntries([row('c'), row('d')].map((value) => [recordKey(value.t, value.id), value]));
      replica.staging[scope] = { digest: `digest-${n}-${scope}`, rows: Object.fromEntries([row('e'), row('f')].map((value) => [recordKey(value.t, value.id), value])) };
      replica.cursors[scope] = { cursor: `cursor-${n}`, seq: n };
      replica.known[scope] = [n];
    }
    replica.staging['self/overlay/b_00000001'] = { digest: `empty-${n}`, rows: {} };
    replica.device.probe = { rack: { text: `device-${n}` }, pending: [`pending-${n}`] };
    replica.outbox = [{ localId: `gesture-${n}/0`, gestureId: `gesture-${n}`, commitOrder: n, scope: 'self/probe', state: 'held', releaseAt: 9999, content: { d: [] } }];
    replica.notices = [{ id: `notice-${n}`, scope: 'self/probe', code: 'conflict', content: { d: [] }, at: n }];
    return replica;
  });
  const device = new Device({ active: replicas[0].id, replicas: replicas.map((replica) => replica.toJSON()), meta: { forkGuard: 'retained' } });
  const records = [];
  const add = (key, value) => records.push({ key: JSON.stringify(key), value: structuredClone(value) });
  add(['head'], { active: device.activeReplica.id, meta: device.meta, revision: 9 });
  for (const replica of device.replicas) {
    add(['replica', replica.id], replica.meta);
    for (const kind of ['confirmed', 'spentIds']) for (const [scope, rows] of Object.entries(replica[kind])) {
      for (const [key, row] of Object.entries(rows)) add([kind, replica.id, scope, key], row);
    }
    for (const [scope, staged] of Object.entries(replica.staging)) {
      add(['staging', replica.id, scope], staged.digest);
      for (const [key, row] of Object.entries(staged.rows)) add(['stagedRow', replica.id, scope, key], row);
    }
    for (const kind of ['cursors', 'known']) for (const [scope, value] of Object.entries(replica[kind])) add([kind, replica.id, scope], value);
    for (const [product, rows] of Object.entries(replica.device)) for (const [key, value] of Object.entries(rows)) add(['device', replica.id, product, key], value);
    for (const entry of replica.outbox) add(['outbox', replica.id, entry.localId], entry);
    replica.notices.forEach((notice, index) => add(['notice', replica.id, index], notice));
  }
  return { records, expected: device.toJSON() };
}
