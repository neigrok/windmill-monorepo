import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { compareRecords } from '../../../../packages/api-contract/sync/reference/core/rows.js';
import { drawn, stored } from '../../../../packages/api-contract/sync/reference/client/views.js';
import { undoOffers } from '../../../../packages/api-contract/sync/reference/client/hold.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { environment, until } from './fakes.js';
import { overlayScope, productScope, registry, row, Rng, serverState, st, treeScope } from './oracle-adapters/fixtures.js';

const tree = 'tree/b_00000001', overlay = 'self/overlay/b_00000001';
const names = ['oak', 'ash', 'elm', 'yew', 'fir', 'a-b', 'a', 'ab', 'z9'];

function reference(replica, scope, view) {
  return [...view(replica, registry, scope).values()].sort(compareRecords).map((record) => {
    const envelope = replica.confirmedRow(scope, record.t, record.id);
    return { ...record, ...Object.fromEntries(['seq', 'rc', 'ru'].filter((name) => envelope?.[name] !== undefined).map((name) => [name, envelope[name]])) };
  });
}

for (const seed of [1, 2, 3]) test(`scope observations equal the reference views after every commit, hold, undo, push, peer pull and reopen: seed ${seed}`, async () => {
  const env = environment(), peer = environment(), rng = new Rng(seed);
  env.state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), 'tree:b_00000001': treeScope('A', 'b_00000001'), 'acct:A/overlay/b_00000001': overlayScope('A', 'b_00000001') },
    rows: { 'acct:A/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1)], born: st(1), seq: 1 })] },
  }));
  peer.transport.request = (endpoint, request) => env.transport.request(endpoint, request);
  env.transport.account = 'A';
  const open = async (options) => {
    const engine = await BrowserSyncEngine.open(options);
    for (const scope of [tree, overlay]) engine.observe(scope);
    await engine.start(); await until(() => engine.leader);
    return engine;
  };
  const sync = async (engine) => { engine.kick(); await engine.send(); engine.kickPull(); await engine.pull(); };
  let engine = await open(env.options);
  const writer = await open(peer.options);
  const check = (step) => {
    const replica = engine.device.activeReplica;
    for (const scope of [tree, overlay]) {
      const snapshot = engine.observe(scope).getSnapshot();
      assert.deepEqual(snapshot.drawn, reference(replica, scope, drawn), `step ${step}: drawn ${scope}`);
      assert.deepEqual(snapshot.stored, reference(replica, scope, stored), `step ${step}: stored ${scope}`);
      assert.deepEqual(snapshot.undoOffers, undoOffers(replica, scope), `step ${step}: undo offers ${scope}`);
    }
  };
  try {
    await engine.signIn('A'); await writer.signIn('A');
    await sync(engine); await sync(writer);
    const alive = (source) => source.observe(tree).getSnapshot().drawn.filter((record) => record.t === 'tag' && record.life[0] === 'alive').map((record) => record.id);
    const pick = (list) => list[rng.int(list.length)];
    for (let step = 0; step < 60; step++) {
      env.timers.time += 1000; peer.timers.time += 1000;
      const tags = alive(engine);
      const kind = rng.int(10);
      if (kind === 0 || tags.length < 2) await engine.commit(tree, [{ op: 'create', t: 'tag', id: pick(names), f: { label: `L${step}` } }], { hold: rng.int(3) === 0 });
      else if (kind === 1) await engine.commit(tree, [{ op: 'update', t: 'tag', id: pick(tags), f: { label: `U${step}` } }], { hold: rng.int(3) === 0 });
      else if (kind === 2) await engine.commit(tree, [{ op: 'delete', t: 'tag', id: pick(tags) }], { hold: rng.int(2) === 0 });
      else if (kind === 3) await engine.commit(tree, [{ op: 'put', t: 'link', id: [pick(tags), pick(tags)], present: rng.int(4) > 0, f: { strength: rng.int(10) } }]);
      else if (kind === 4) await engine.commit(overlay, [{ op: 'write', t: 'mark', id: pick(tags), x: { memo: `m${step}` }, f: { done: rng.int(2) === 0 } }], { hold: rng.int(3) === 0 });
      else if (kind === 5) {
        const offers = engine.observe(tree).getSnapshot().undoOffers;
        if (offers.length) await engine.undo(offers.at(-1).id);
      } else if (kind === 6) {
        const held = engine.device.activeReplica.entries().find((entry) => entry.state === 'held');
        if (held) await engine.release(held.localId);
        await sync(engine);
      } else if (kind === 7) {
        const theirs = alive(writer);
        await writer.commit(tree, theirs.length && rng.int(2) ? [{ op: 'update', t: 'tag', id: pick(theirs), f: { label: `P${step}` } }]
          : [{ op: 'create', t: 'tag', id: pick(names), f: { label: `P${step}` } }]);
        await sync(writer); await sync(engine);
      } else if (kind === 8) { engine.close(); engine = await open(env.options); }
      else { await sync(writer); await sync(engine); }
      check(step);
    }
    assert.deepEqual(env.failures, []);
  } finally { engine.close(); writer.close(); }
});
