import assert from 'node:assert/strict';
import test from 'node:test';
import { Replica } from '../../client/replica.js';
import { firstPullComplete, reconcile, subscriptionsOf } from '../../client/subscriptions.js';
import { registry } from '../../vectors/fixtures.js';

function boundWithBoards() {
  return new Replica({
    meta: { ...Replica.fresh({ replica: 'rp_1', state: 'bound', account: 'A' }).meta },
    confirmed: {
      'self/probe': [
        { t: 'board', id: 'b_00000001', life: ['alive', '1:0:r_aaaaaaaaaaaa'], born: '1:0:r_aaaaaaaaaaaa', seq: 1, rc: 1, ru: 1 },
        { t: 'board', id: 'b_00000002', life: ['dead', '2:0:r_aaaaaaaaaaaa'], born: '1:0:r_aaaaaaaaaaaa', seq: 2, rc: 1, ru: 2 },
      ],
    },
    cursors: {
      'self/probe': { cursor: 'c1', digest: '0'.repeat(64), booted: true },
      'tree/b_00000002': { cursor: 'c2', digest: '0'.repeat(64), booted: true },
    },
    outbox: [
      { localId: 'g1/0', gestureId: 'g1', lineage: 'A', scope: 'tree/b_00000002', state: 'acked', commitOrder: 1, releaseAt: 0, stamp: '3:0:r_aaaaaaaaaaaa', resultSeq: 4, resultEpoch: 'ep-1', intent: { scope: 'tree/b_00000002', d: [{ t: 'meta', id: 'meta', f: { title: ['x', '3:0:r_aaaaaaaaaaaa'] } }], gestureId: 'g1' } },
      { localId: 'g2/0', gestureId: 'g2', lineage: 'A', scope: 'tree/b_00000003', state: 'ready', commitOrder: 2, releaseAt: 0, stamp: '4:0:r_aaaaaaaaaaaa', intent: { scope: 'tree/b_00000003', d: [{ t: 'meta', id: 'meta', f: { title: ['y', '4:0:r_aaaaaaaaaaaa'] } }], gestureId: 'g2' } },
    ],
  });
}

test('§7.9: a bound replica subscribes its product scope and each alive board\'s tree and overlay', () => {
  assert.deepEqual(subscriptionsOf(boundWithBoards(), registry, ['probe']), ['self/probe', 'tree/b_00000001', 'self/overlay/b_00000001']);
  assert.deepEqual(subscriptionsOf(Replica.fresh({ replica: 'rp_2', state: 'anon' }), registry, ['probe']), []);
});

test('§8.1: leaving the subscription set forgets the scope and resolves its acked entries, pending ones stay', () => {
  const replica = boundWithBoards();
  const ended = [];
  reconcile(replica, { ended }, subscriptionsOf(replica, registry, ['probe']));
  assert.deepEqual(ended, [{ localId: 'g1/0', outcome: 'resolved', event: 'resolve' }]);
  assert.deepEqual(Object.keys(replica.cursors), ['self/probe']);
  assert.deepEqual(replica.outbox.map((entry) => [entry.localId, entry.state]), [['g2/0', 'ready']]);
});

test('§7.9 firstPullComplete: booted for a pulled scope, true for a scope the replica does not pull', () => {
  const replica = boundWithBoards();
  const scopes = subscriptionsOf(replica, registry, ['probe']);
  assert.equal(firstPullComplete(replica, 'self/probe', scopes), true);
  assert.equal(firstPullComplete(replica, 'tree/b_00000001', scopes), false);
  assert.equal(firstPullComplete(replica, 'tree/b_99999999', scopes), true);
});
