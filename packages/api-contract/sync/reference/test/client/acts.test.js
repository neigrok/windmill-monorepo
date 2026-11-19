// §7.1 Ordered local acts, staged: a composed act's later load reads through the segments staged before it, a staged
// local refusal is answered before anything is written, and the request's segments commit afresh as one act.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActCommit } from '../../client/acts.js';
import { Device, freshMeta } from '../../client/replica.js';
import { drawn } from '../../client/views.js';
import { ACTOR, registry } from '../../vectors/fixtures.js';
import { settle } from '../../vectors/steps.js';

const REPLICA = 'rp_00000000000000000000000000000001';
const SCOPE = 'self/probe';

function context(device) {
  let gestures = 0;
  return { registry, actor: ACTOR, deviceNow: 5000, ended: [], device, nextGestureId: () => `g${(gestures += 1)}`, draw: () => 0 };
}

const create = (title) => ({ changes: [{ op: 'create', t: 'card', id: 'card0001', f: { title } }] });
const rename = (title) => ({ changes: [{ op: 'update', t: 'card', id: 'card0001', f: { title } }] });
const titleIn = (views) => views.drawn.get(JSON.stringify(['card', 'card0001']))?.f?.title?.[0] ?? null;

test('a later load reads through a staged segment, and the request commits every segment as one act', () => {
  const device = new Device(settle({ active: REPLICA, replicas: [{ meta: freshMeta(REPLICA, 'bound', 'A') }] }));
  const replica = device.activeReplica;
  const reads = [];
  const outcome = new ActCommit().advance(replica, context(device), (act) => {
    reads.push(act.inScope(SCOPE, titleIn));
    assert.equal(act.stage(SCOPE, () => create('First')), null);
    act.beginPart();
    reads.push(act.inScope(SCOPE, titleIn));
    assert.equal(act.stage(SCOPE, (views) => rename(`${titleIn(views)}!`)), null);
    return { request: { scopes: [SCOPE, SCOPE], hold: false }, value: [create('First'), rename('First!')] };
  }, (gestures, index) => gestures[index]).outcome;
  assert.deepEqual(reads, [null, 'First']);
  assert.deepEqual(outcome.segments.map(({ localIds }) => localIds), [['g1/0'], ['g1/1']]);
  assert.equal(drawn(replica, registry, SCOPE).get(JSON.stringify(['card', 'card0001'])).f.title[0], 'First!');
});

test('a staged local refusal is answered, and the act it ends writes nothing', () => {
  const gone = 'tree/b_00000005';
  const device = new Device(settle({ active: REPLICA, replicas: [{ meta: freshMeta(REPLICA, 'bound', 'A'), known: { [gone]: 'gone' } }] }));
  const replica = device.activeReplica;
  const before = replica.toJSON();
  const outcome = new ActCommit().advance(replica, context(device), (act) => {
    assert.equal(act.stage(SCOPE, () => create('First')), null);
    assert.deepEqual(act.stage(gone, () => ({ changes: [{ op: 'create', t: 'tag', id: 'elm', f: { label: 'Elm' } }] })), { refused: 'scope-dead' });
    return { request: null, value: null };
  }, () => assert.fail('a refused act reaches no segment')).outcome;
  assert.equal(outcome, null);
  assert.deepEqual(replica.toJSON(), before);
});
