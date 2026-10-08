// §11.2 #3 (INV-6): intents of one record without a guard or a command, admitted by the reference
// server; after the results and a pull to the head, the client's drawn view equals the server's alive
// rows, and its digest equals the scope's.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { steadyTiming } from '../../../../../packages/api-contract/sync/reference/core/clock.js';
import { compareRecords, isAlive, latticeOf } from '../../../../../packages/api-contract/sync/reference/core/rows.js';
import { commit } from '../../../../../packages/api-contract/sync/reference/client/commit.js';
import { onPullResponse, pullRequest } from '../../../../../packages/api-contract/sync/reference/client/puller.js';
import { Replica } from '../../../../../packages/api-contract/sync/reference/client/replica.js';
import { nextPush, onPushResponse } from '../../../../../packages/api-contract/sync/reference/client/sender.js';
import { drawn } from '../../../../../packages/api-contract/sync/reference/client/views.js';
import { pull } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../../packages/api-contract/sync/reference/server/push.js';
import { ServerState } from '../../../../../packages/api-contract/sync/reference/server/state.js';
import { ACTOR, Rng, overlayScope, product, productScope, registry, row, serverState, st, treeScope } from '../oracle-adapters/fixtures.js';

const BOARD = 'b_00000001';
const SCOPES = { 'self/probe': 'acct:A/probe', [`tree/${BOARD}`]: `tree:${BOARD}`, [`self/overlay/${BOARD}`]: `acct:A/overlay/${BOARD}` };
const WORDS = ['oak', 'ash', 'elm', 'yew', 'bay'];

function startServer() {
  return new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), [`tree:${BOARD}`]: treeScope('A', BOARD), [`acct:A/overlay/${BOARD}`]: overlayScope('A', BOARD) },
    rows: {
      'acct:A/probe': [row({ t: 'board', id: BOARD, life: ['alive', st(900)], born: st(900), seq: 1 })],
      [`tree:${BOARD}`]: [row({ t: 'tag', id: 'oak', life: ['alive', st(900)], born: st(900), f: { label: ['Oak', st(900)] }, seq: 1 })],
    },
  }));
}

function viewOf(row) {
  const record = { t: row.t, id: row.id, ...latticeOf(row) };
  if (row.x) record.x = Object.fromEntries(Object.entries(row.x).map(([name, text]) => [name, text.text]));
  if (row.v) record.v = row.v;
  return record;
}

function gesture(rng, replica, k) {
  const probe = [...drawn(replica, registry, 'self/probe').values()];
  const cards = probe.filter((record) => record.t === 'card' && isAlive(record));
  const tags = [...drawn(replica, registry, `tree/${BOARD}`).values()].filter((record) => record.t === 'tag' && isAlive(record));
  const roll = rng.int(8);
  if (roll === 0 && cards.length < 3) return ['self/probe', [{ op: 'create', t: 'card', id: `card${String(k).padStart(4, '0')}`, f: { title: rng.pick(WORDS), size: rng.int(10000) / 777 } }]];
  if (roll === 1 && cards.length) return ['self/probe', [{ op: 'update', t: 'card', id: rng.pick(cards).id, f: { title: rng.pick(WORDS), tier: rng.pick(['draft', 'review', 'done', 'dropped']), claim: rng.pick(WORDS) } }]];
  if (roll === 2 && cards.length) return ['self/probe', [{ op: 'delete', t: 'card', id: rng.pick(cards).id }]];
  if (roll === 3) return [`tree/${BOARD}`, [{ op: 'create', t: 'tag', label: `${rng.pick(WORDS)} ${k}`, f: { label: rng.pick(WORDS) } }]];
  if (roll === 4 && tags.length > 1) return [`tree/${BOARD}`, [{ op: 'put', t: 'link', id: [rng.pick(tags).id, rng.pick(tags).id], present: rng.chance(0.7) }]];
  if (roll === 5 && tags.length) {
    const tag = rng.pick(tags).id;
    const shown = drawn(replica, registry, `self/overlay/${BOARD}`).get(JSON.stringify(['mark', tag]))?.x?.memo ?? '';
    return [`self/overlay/${BOARD}`, [{ op: 'write', t: 'mark', id: tag, x: { memo: `${shown} ${rng.pick(WORDS)}`.trim().slice(-36) } }]];
  }
  if (roll === 6 && tags.length > 1) return [`tree/${BOARD}`, [{ op: 'delete', t: 'tag', id: rng.pick(tags).id }]];
  return [`tree/${BOARD}`, [{ op: 'write', t: 'meta', id: 'meta', f: { title: rng.pick(WORDS) } }]];
}

test('after results and a pull to the head, drawn equals the server rows', () => {
  let compared = 0;
  for (let seed = 1; seed <= 60; seed += 1) {
    const rng = new Rng(seed);
    let server = startServer();
    const replica = Replica.fresh({ replica: 'rp_00000000000000000000000000000001', state: 'bound', account: 'A' });
    const ended = [];
    let now = 5000;
    for (let round = 0; round < 12; round += 1) {
      for (let k = 0; k < 1 + rng.int(5); k += 1) {
        now += 10;
        const [scope, changes] = gesture(rng, replica, round * 10 + k);
        commit(replica, { registry, actor: ACTOR, deviceNow: now, ended, nextGestureId: () => `g${round}-${k}` }, scope, changes);
      }
      const ctx = { registry, actor: ACTOR, deviceNow: now, ended, telemetry: [], appVersion: '1', newReplicaId: () => assert.fail('no re-identify') };
      for (let request = nextPush(replica, ctx); request; request = nextPush(replica, ctx)) {
        const out = push({ state: server, registry, product, account: 'A', request, serverNow: now });
        server = out.state;
        onPushResponse(replica, ctx, request, out.response, steadyTiming(now, now));
      }
      for (let more = true; more;) {
        const request = pullRequest(replica, registry, Object.keys(SCOPES));
        const pulled = pull({ state: server, registry, product, account: 'A', request, serverNow: now });
        server = pulled.state;
        const response = pulled.response;
        onPullResponse(replica, ctx, request, response, steadyTiming(now, now));
        more = response.body.pages.some((page) => page.more);
      }
      assert.deepEqual(replica.outbox, [], `seed ${seed} round ${round}: outbox drained`);
      assert.deepEqual(ctx.telemetry, [], `seed ${seed} round ${round}: digest checks match`);
      for (const [scope, key] of Object.entries(SCOPES)) {
        const mine = [...drawn(replica, registry, scope).values()].sort(compareRecords);
        const truth = server.rowsOf(key).filter(isAlive).map(viewOf).sort(compareRecords);
        assert.deepEqual(mine, truth, `seed ${seed} round ${round} ${scope}`);
        compared += truth.length;
        assert.equal(replica.cursors[scope].digest, server.scope(key).digest, `seed ${seed} round ${round} ${scope} digest`);
      }
    }
  }
  assert.ok(compared > 3000, `only ${compared} rows compared`);
});
