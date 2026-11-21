import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { compareRecords, recordKey } from '../../../../packages/api-contract/sync/reference/core/rows.js';
import { effectsOf } from '../../../../packages/api-contract/sync/reference/client/projections.js';
import { drawn, stored } from '../../../../packages/api-contract/sync/reference/client/views.js';
import { undoOffers } from '../../../../packages/api-contract/sync/reference/client/hold.js';
import { noticesOfProduct } from '../../../../packages/api-contract/sync/reference/client/refusal.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { environment, until } from './fakes.js';
import { overlayScope, product, productScope, registry, row, Rng, serverState, st, treeScope } from './oracle-adapters/fixtures.js';

const tree = 'tree/b_00000001', overlay = 'self/overlay/b_00000001';
const names = ['oak', 'ash', 'elm', 'yew', 'fir', 'a-b', 'a', 'ab', 'z9'];

const QUEUED = ['held', 'ready', 'sent', 'acked'];
const reaches = (entry, scope) => effectsOf(entry, { active: true }).some((effect) => effect.scope === scope);

function pendingKeys(replica, scope) {
  return new Set(replica.entries().filter((entry) => QUEUED.includes(entry.state))
    .flatMap((entry) => effectsOf(entry, { active: true }).filter((effect) => effect.scope === scope).flatMap(({ d }) => d))
    .map((delta) => recordKey(delta.t, delta.id)));
}

function outboxOf(replica, scope) {
  const entries = replica.entries().filter((entry) => entry.scope === scope || reaches(entry, scope));
  return Object.fromEntries(QUEUED.map((state) => [state, entries.filter((entry) => entry.state === state).length]));
}

function reference(replica, scope, view) {
  return [...view(replica, registry, scope).values()].sort(compareRecords).map((record) => {
    const envelope = replica.confirmedRow(scope, record.t, record.id);
    return { ...record, ...Object.fromEntries(['seq', 'rc', 'ru'].filter((name) => envelope?.[name] !== undefined).map((name) => [name, envelope[name]])) };
  });
}

for (const seed of [1, 2, 3]) test(`scope observations equal the reference views after every commit, scoped prediction, hold, undo, push, peer pull and reopen: seed ${seed}`, async () => {
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
      const pending = pendingKeys(replica, scope);
      assert.deepEqual(snapshot.pending, snapshot.drawn.filter((record) => pending.has(recordKey(record.t, record.id))), `step ${step}: pending ${scope}`);
      assert.deepEqual(snapshot.outbox, outboxOf(replica, scope), `step ${step}: outbox ${scope}`);
      assert.equal(snapshot.loaded, true, `step ${step}: loaded ${scope}`);
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
      else if (kind === 4 && rng.int(2)) await engine.commit(overlay, [{ op: 'write', t: 'mark', id: pick(tags), x: { memo: `m${step}` }, f: { done: rng.int(2) === 0 } }], { hold: rng.int(3) === 0 });
      else if (kind === 4) await engine.commit('self/probe', [], { hold: rng.int(2) === 0,
        cmd: { name: 'probe.branch', args: { parent: 'b_00000001', child: 'b_00000002', title: `B${step}` } },
        scopedPredict: [{ scope: tree, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: `B${step}` } }] }] });
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

test('a product\'s notices are observed in every scope: a tree\'s scope-dead notice the device never observed, gone once dismissed, and back once content folds in', async () => {
  const env = environment(), peer = environment();
  env.state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), 'tree:b_00000001': treeScope('A', 'b_00000001'), 'acct:A/overlay/b_00000001': overlayScope('A', 'b_00000001') },
    rows: { 'acct:A/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1)], born: st(1), seq: 1 })],
      'tree:b_00000001': [row({ t: 'tag', id: 'oak', life: ['alive', st(1)], born: st(1), f: { label: ['Oak', st(1)] }, seq: 1 })] },
  }));
  peer.transport.request = (endpoint, request) => env.transport.request(endpoint, request);
  env.transport.account = 'A';
  const open = async (options) => { const engine = await BrowserSyncEngine.open(options); await engine.start(); await until(() => engine.leader); return engine; };
  const sync = async (engine) => { engine.kick(); await engine.send(); engine.kickPull(); await engine.pull(); };
  let peerIds = 100;
  const engine = await open(env.options), writer = await open({ ...peer.options, newReplicaId: () => `rp_${String(++peerIds).padStart(32, '0')}` });
  const notices = engine.observeNotices('probe');
  let told = 0;
  notices.subscribe(() => { told += 1; });
  const read = () => noticesOfProduct(engine.device.activeReplica, registry, 'probe');
  const shown = () => notices.getSnapshot().notices.map(({ scope, code, dismissed, content }) => ({ scope, code, dismissed, dependents: content.dependents?.length ?? 0 }));
  try {
    await engine.signIn('A'); await writer.signIn('A');
    for (const each of [engine, engine, writer, writer]) await sync(each);
    const quiet = notices.getSnapshot();
    await engine.commit(tree, [{ op: 'update', t: 'tag', id: 'oak', f: { label: 'Old oak' } }]);
    assert.equal(notices.getSnapshot(), quiet, 'a write that changes no notice keeps the snapshot');

    await writer.commit('self/probe', [{ op: 'delete', t: 'board', id: 'b_00000001' }]);
    await sync(writer); await sync(engine); await sync(engine);
    assert.deepEqual({ shown: shown(), held: Object.keys(engine.device.activeReplica.confirmed).includes(tree), known: engine.device.activeReplica.known[tree] },
      { shown: [{ scope: tree, code: 'scope-dead', dismissed: undefined, dependents: 0 }], held: false, known: 'gone' });
    assert.deepEqual(notices.getSnapshot().notices, read());

    const dead = notices.getSnapshot().notices[0].id;
    assert.equal(await engine.dismissNotice(dead), true);
    assert.deepEqual(shown(), []);

    await engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'card0009', f: { title: 'Thirteen char' } }]);
    await engine.commit('self/probe', [{ op: 'update', t: 'card', id: 'card0009', f: { title: 'Fixed' } }, { op: 'create', t: 'card', id: 'card0010', f: { title: 'Fourth' } }], { atomic: true });
    const budgeted = (endpoint, request) => {
      env.transport.response = null;
      if (endpoint !== 'push') {
        const answer = env.transport.request(endpoint, request);
        env.transport.response = budgeted;
        return answer;
      }
      const out = push({ state: env.state, registry, product, account: 'A', request, serverNow: env.timers.time, budget: 1 });
      env.state = out.state;
      const at = { wall: env.timers.time, mono: env.timers.time, boot: 'test' };
      return { response: out.response, timing: { send: at, recv: at } };
    };
    env.transport.response = budgeted;
    engine.kick(); await engine.send();
    const refused = notices.getSnapshot().notices.find((notice) => notice.code === 'invalid').id;
    await engine.dismissNotice(refused);
    assert.deepEqual(shown(), []);

    await engine.commit('self/probe', [{ op: 'update', t: 'card', id: 'card0010', f: { title: 'Edited' } }]);
    const before = told;
    await sync(engine); await sync(engine);
    assert.deepEqual(shown(), [{ scope: 'self/probe', code: 'invalid', dismissed: undefined, dependents: 2 }]);
    assert.deepEqual(notices.getSnapshot().notices, read());
    assert.ok(told > before, 'the fold told the holder');

    notices.release();
    const released = told;
    await engine.dismissNotice(refused);
    assert.equal(told, released, 'a released hold is told nothing');
    assert.deepEqual(engine.observeNotices('probe').getSnapshot().notices, []);
    assert.deepEqual(env.failures, []);
  } finally { engine.close(); writer.close(); }
});
