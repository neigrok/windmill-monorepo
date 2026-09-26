import assert from 'node:assert/strict';
import test from 'node:test';
import { commit } from '../../client/commit.js';
import { Replica } from '../../client/replica.js';
import { mintId } from '../../core/derive.js';
import { registry, row, st } from '../../vectors/fixtures.js';

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
