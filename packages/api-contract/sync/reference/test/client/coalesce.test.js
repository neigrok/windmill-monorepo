// §11.2 #2: for a single-actor outbox, drawn with coalescing equals drawn without it. The uncoalesced
// replica numbers every ready entry after each step, so no later intent can join an earlier one.
// Drawn is compared over visible records: a create and delete that cancel leave no row where the
// uncoalesced outbox draws a dead one, and neither is drawn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareRecords, isVisible } from '../../core/rows.js';
import { commit } from '../../client/commit.js';
import { releaseAll, releaseDue } from '../../client/hold.js';
import { Replica } from '../../client/replica.js';
import { nextPush } from '../../client/sender.js';
import { drawn } from '../../client/views.js';
import { ACTOR, Rng, registry, row, st } from '../../vectors/fixtures.js';

const BOARD = 'b_00000001';
const TREE = `tree/${BOARD}`;
const OVERLAY = `self/overlay/${BOARD}`;
const SCOPES = ['self/probe', TREE, OVERLAY];
const WORDS = ['oak', 'ash', 'elm', 'yew'];

function start() {
  const replica = Replica.fresh({ replica: 'rp_00000000000000000000000000000001', state: 'bound', account: 'A' });
  replica.confirmed = {};
  for (const card of [1, 2]) replica.putConfirmed('self/probe', row({ t: 'card', id: `card000${card}`, life: ['alive', st(1000 + card)], born: st(1000 + card), f: { title: [`Card ${card}`, st(1000 + card)] }, seq: card }));
  for (const tag of ['oak', 'elm']) replica.putConfirmed(TREE, row({ t: 'tag', id: tag, life: ['alive', st(1000)], born: st(1000), f: { label: [tag, st(1000)] }, seq: 1 }));
  replica.putConfirmed(OVERLAY, row({ t: 'mark', id: 'oak', x: { memo: { text: 'first', rev: 2, merged: false } }, seq: 2 }));
  return replica;
}

function visibleDrawn(replica) {
  return SCOPES.map((scope) => [...drawn(replica, registry, scope).values()]
    .filter((record) => isVisible(registry.type(record.t), record))
    .sort(compareRecords));
}

function gesture(rng, replica, k) {
  const cards = [...drawn(replica, registry, 'self/probe').values()].filter((record) => record.t === 'card' && isVisible(registry.type('card'), record));
  const tags = [...drawn(replica, registry, TREE).values()].filter((record) => record.t === 'tag');
  const roll = rng.int(9);
  if (roll === 7 && tags.length) {
    const tag = rng.pick(tags);
    return [TREE, [{ op: tag.life?.[0] === 'alive' ? 'delete' : 'revive', t: 'tag', id: tag.id }], {}];
  }
  if (roll === 8) return [TREE, [{ op: 'create', t: 'tag', id: `t${String(k).padStart(4, '0')}`, f: { label: rng.pick(WORDS) } }], {}];
  if (roll === 0) return ['self/probe', [{ op: 'create', t: 'card', id: `new${String(k).padStart(5, '0')}`, f: { title: rng.pick(WORDS) } }], {}];
  if (roll === 1 && cards.length) return ['self/probe', [{ op: 'update', t: 'card', id: rng.pick(cards).id, f: { title: rng.pick(WORDS), tier: rng.pick(['draft', 'review', 'done']) } }], {}];
  if (roll === 2 && cards.length) return ['self/probe', [{ op: 'delete', t: 'card', id: rng.pick(cards).id }], { hold: rng.chance(0.5) }];
  if (roll === 3) return [TREE, [{ op: 'put', t: 'link', id: [rng.pick(['oak', 'elm']), rng.pick(['oak', 'elm'])], present: rng.chance(0.6) }], {}];
  if (roll === 4) return [OVERLAY, [{ op: 'write', t: 'mark', id: rng.pick(['oak', 'elm']), x: { memo: `${rng.pick(WORDS)} ${rng.pick(WORDS)}` } }], {}];
  if (roll === 5) return [OVERLAY, [{ op: 'write', t: 'mark', id: rng.pick(['oak', 'elm']), f: { done: rng.chance(0.5) } }], {}];
  return [TREE, [{ op: 'update', t: 'tag', id: rng.pick(['oak', 'elm']), f: { label: rng.pick(WORDS) } }], {}];
}

test('drawn with coalescing equals drawn without it, for single-actor outboxes', () => {
  let joins = 0;
  for (let seed = 1; seed <= 150; seed += 1) {
    const rng = new Rng(seed);
    const joined = start();
    const apart = start();
    const endedJoined = [];
    const endedApart = [];
    for (let k = 0; k < 40; k += 1) {
      const deviceNow = 5000 + k * 1000;
      const ctx = (ended) => ({ registry, actor: ACTOR, deviceNow, ended, nextGestureId: () => `g${k}` });
      if (rng.chance(0.15)) {
        releaseDue(joined, registry, endedJoined, deviceNow);
        releaseDue(apart, registry, endedApart, deviceNow);
      } else if (rng.chance(0.05)) {
        releaseAll(joined, registry, endedJoined);
        releaseAll(apart, registry, endedApart);
      } else {
        const [scope, changes, opts] = gesture(rng, joined, k);
        commit(joined, ctx(endedJoined), scope, changes, opts);
        commit(apart, ctx(endedApart), scope, changes, opts);
      }
      nextPush(apart, ctx(endedApart));
      assert.deepEqual(visibleDrawn(joined), visibleDrawn(apart), `seed ${seed}, step ${k}`);
    }
    assert.ok(endedApart.every((end) => end.outcome !== 'coalesced'), `seed ${seed}: the uncoalesced replica coalesced`);
    joins += endedJoined.filter((end) => end.outcome === 'coalesced').length;
  }
  assert.ok(joins > 500, `only ${joins} joins happened`);
});
