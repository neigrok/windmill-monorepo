// §7.6 and D-17: one product's notices in every scope, read whole from the replica, whether or not the device still
// holds or observes their scope, but a dismissed one until content folds into it again.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Device, freshMeta } from '../../client/replica.js';
import { noticesOfProduct } from '../../client/refusal.js';
import { composeRegistry } from '../../core/composition.js';
import { Registry } from '../../core/registry.js';
import { pull } from '../../server/pull.js';
import { push } from '../../server/push.js';
import { ServerState } from '../../server/state.js';
import { overlayScope, product, productScope, registry, row, serverState, st, treeScope } from '../../vectors/fixtures.js';
import { runSteps, settle } from '../../vectors/steps.js';

const REPLICA = 'rp_00000000000000000000000000000001';
const BOARD = 'b_00000001';
const TREE = `tree/${BOARD}`;
const OVERLAY = `self/overlay/${BOARD}`;
const corpus = (path) => JSON.parse(readFileSync(new URL(`../../../corpus/${path}`, import.meta.url), 'utf8'));
const replicaOf = (out) => new Device(out.device).activeReplica;

test('a product\'s notices hold a tree\'s scope-dead notices whole once the device has forgotten the tree: no scope it still holds names them', () => {
  const board = (life) => row({ t: 'board', id: BOARD, life, born: st(900), seq: life[0] === 'dead' ? 2 : 1 });
  const tag = row({ t: 'tag', id: 'oak', life: ['alive', st(1000)], born: st(1000), f: { label: ['Oak', st(1000)] }, seq: 1 });
  let server = new ServerState(serverState({
    scopes: {
      'acct:A/probe': productScope('A'),
      [`tree:${BOARD}`]: treeScope('A', BOARD, { state: 'dead', deadAt: 4000 }),
      [`acct:A/overlay/${BOARD}`]: overlayScope('A', BOARD, { state: 'dead', deadAt: 4000 }),
    },
    rows: { 'acct:A/probe': [board(['dead', st(4000, 0, 'r_cccccccccccc')])], [`tree:${BOARD}`]: [tag] },
  }));
  const input = {
    device: settle({ active: REPLICA, replicas: [{ meta: freshMeta(REPLICA, 'bound', 'A'), confirmed: { 'self/probe': [board(['alive', st(900)])], [TREE]: [tag] } }] }),
    steps: [
      { op: 'commit', scope: TREE, changes: [{ op: 'update', t: 'tag', id: 'oak', f: { label: 'Old oak' } }], deviceNow: 5000 },
      { op: 'commit', scope: OVERLAY, changes: [{ op: 'write', t: 'mark', id: 'oak', f: { done: true } }], deviceNow: 5001 },
      { op: 'push', deviceNow: 5002 },
    ],
  };
  const answer = (op, serve, deviceNow) => {
    const request = runSteps(input).returns.at(-1);
    const out = serve({ state: server, registry, product, account: 'A', request, serverNow: deviceNow });
    server = out.state;
    input.steps.push({ op, response: out.response, deviceNow, tSend: deviceNow, tRecv: deviceNow });
  };
  answer('pushResponse', push, 5002);
  input.steps.push({ op: 'pull', scopes: [TREE], deviceNow: 5003 });
  answer('pullResponse', pull, 5003);

  const replica = replicaOf(runSteps(input));
  assert.deepEqual({ known: replica.known[TREE], held: Object.keys(replica.confirmed), codes: replica.notices.map(({ scope, code }) => [scope, code]) },
    { known: 'gone', held: ['self/probe'], codes: [[TREE, 'scope-dead'], [OVERLAY, 'scope-dead']] });
  assert.deepEqual(noticesOfProduct(replica, registry, 'probe'), replica.notices);
  assert.deepEqual(noticesOfProduct(replica, registry, 'probe')[0].content.d.map(({ t, id, f }) => [t, id, f.label[0]]), [['tag', 'oak', 'Old oak']]);
});

test('a dismissed notice is not read, and an orphan\'s refusal folding content into it reads it again', () => {
  const fold = corpus('refusal/fold.json').find((vector) => vector.name.startsWith('content folding into a dismissed notice shows it again'));
  const dismissed = fold.input.steps.findIndex((step) => step.op === 'dismiss');
  const before = noticesOfProduct(replicaOf(runSteps({ ...fold.input, steps: fold.input.steps.slice(0, dismissed + 1) })), registry, 'probe');
  const after = noticesOfProduct(replicaOf(runSteps(fold.input)), registry, 'probe');
  assert.deepEqual(before, []);
  assert.deepEqual(after.map(({ id, dismissed, content }) => ({ id, dismissed, dependents: content.dependents.length })),
    [{ id: 'notice:g1/0', dismissed: undefined, dependents: 2 }]);
  assert.deepEqual(after, new Device(fold.expect.device).activeReplica.notices);
});

test('in the composition a product reads the notices of its own scopes, its trees and overlays among them, and no other product\'s', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../composition.json', import.meta.url), 'utf8'));
  const documents = Object.fromEntries(manifest.registries.map((file) => [file, JSON.parse(readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8'))]));
  const composed = new Registry(composeRegistry(manifest, documents));
  const notice = (n, scope) => ({ id: `notice:g${n}/0`, scope, code: 'scope-dead', content: { d: [] }, at: 5000 });
  const replica = new Device(settle({ active: REPLICA, replicas: [{ meta: freshMeta(REPLICA, 'bound', 'A'), notices: [
    notice(1, 'self/gym'), notice(2, 'tree/t_0000000000000001'), notice(3, 'self/journal'), notice(4, 'self/overlay/t_0000000000000001'), notice(5, 'self/roadmap'),
  ] }] })).activeReplica;
  assert.deepEqual(Object.fromEntries(['roadmap', 'gym', 'journal'].map((name) => [name, noticesOfProduct(replica, composed, name).map(({ id }) => id)])), {
    roadmap: ['notice:g2/0', 'notice:g4/0', 'notice:g5/0'],
    gym: ['notice:g1/0'],
    journal: ['notice:g3/0'],
  });
});
