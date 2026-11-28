import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { BrowserSyncEngine, ReplicaChanged } from '../../../src/platform/sync/engine.js';
import { CommitError } from '../../../../packages/api-contract/sync/reference/client/commit.js';
import { releaseDue } from '../../../../packages/api-contract/sync/reference/client/hold.js';
import { reidentify } from '../../../../packages/api-contract/sync/reference/client/lifecycle.js';
import { nextPush } from '../../../../packages/api-contract/sync/reference/client/sender.js';
import { Cursor } from '../../../../packages/api-contract/sync/reference/core/wire.js';
import { scopeDigest } from '../../../../packages/api-contract/sync/reference/core/digest.js';
import { hashText } from '../../../src/platform/sync/core/encoding.js';
import { jcs } from '../../../../packages/api-contract/sync/reference/core/jcs.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { environment, until, tick } from './fakes.js';
import { OTHER, overlayScope, product, productScope, registry, row, serverState, st, treeScope } from './oracle-adapters/fixtures.js';
import { Registry } from '../../../../packages/api-contract/sync/reference/core/registry.js';
import { composeRegistry } from '../../../../packages/api-contract/sync/reference/core/composition.js';
import { Device, Replica } from '../../../../packages/api-contract/sync/reference/client/replica.js';

const card = (id = 'card0001') => [{ op: 'create', t: 'card', id, f: { title: 'secret' } }];
const readyHello = (env) => {
  const now = env.timers.time;
  const reading = { wall: now, mono: now, boot: 'test' };
  return { response: { status: 200, body: { as: env.transport.account, epoch: 'ep-1', serverTime: now,
    schema: env.options.registry.version, minSchema: env.options.registry.minVersion } }, timing: { send: reading, recv: reading } };
};
const peer = async (env) => { const engine = await BrowserSyncEngine.open(env.options); await engine.start(); return engine; };
const open = async (env) => {
  const engine = await BrowserSyncEngine.open(env.options);
  engine.observe('self/probe');
  await engine.start();
  await until(() => engine.leader);
  return engine;
};

test('source10 retains exact ready work against server8 and delivers once after a fresh10 hello', async () => {
  const env = environment();
  const spec = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/sync/probe.registry.json', import.meta.url), 'utf8'));
  env.options.registry = new Registry({ ...spec, version: 10, minVersion: 10 });
  let advertised = 8;
  const request = env.transport.request.bind(env.transport);
  env.transport.request = async (endpoint, ...args) => {
    const result = await request(endpoint, ...args);
    if (endpoint === 'hello') Object.assign(result.response.body, { schema: advertised, minSchema: 4 });
    return result;
  };
  const engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  await engine.commit('self/probe', card());
  const before = structuredClone(engine.device.activeReplica.entries());
  const next = engine.device.activeReplica.meta.nextN;
  await engine.send();
  assert.deepEqual(engine.device.activeReplica.entries(), before);
  assert.equal(engine.device.activeReplica.meta.nextN, next);
  assert.equal(env.requests.filter(({ endpoint }) => endpoint === 'push').length, 0);
  advertised = 10;
  for (let attempt = 0; attempt < 3 && !env.requests.some(({ endpoint }) => endpoint === 'push'); attempt++) {
    env.timers.advance(60_000);
    await engine.send(); await until(() => !engine.sending);
  }
  assert.equal(env.requests.filter(({ endpoint }) => endpoint === 'push').length, 1);
  assert.equal(engine.device.activeReplica.entries()[0].state, 'acked');
  engine.close();
});

test('only a 200 hello says the app is too old by its minSchema', async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  await engine.commit('self/probe', card());
  const request = env.transport.request.bind(env.transport);
  env.transport.request = async (endpoint, ...args) => {
    const result = await request(endpoint, ...args);
    if (endpoint === 'hello') result.response = { status: 503, body: { minSchema: 99 } };
    return result;
  };
  await engine.send(); await until(() => !engine.sending);
  assert.equal(engine.upgradeRequired, false);
  assert.equal(env.requests.filter(({ endpoint }) => endpoint === 'push').length, 0);
  env.transport.request = async (endpoint, ...args) => {
    const result = await request(endpoint, ...args);
    if (endpoint === 'hello') result.response.body.minSchema = 99;
    return result;
  };
  env.timers.advance(60_000);
  await engine.send(); await until(() => !engine.sending);
  assert.equal(engine.upgradeRequired, true);
  assert.equal(env.requests.filter(({ endpoint }) => endpoint === 'push').length, 0);
  engine.close();
});

// A bundle of a newer store version opening the device store closes it under this tab, which can keep nothing more.
test('a newer store version opening the device store makes the engine let go of its locks and stop', async () => {
  const env = environment(), engine = await open(env);
  await engine.commit('self/probe', card());
  const newer = engine.store.database.version + 1;
  await new Promise((resolve, reject) => {
    const request = env.indexedDB.open('wm-sync', newer);
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('the older tab kept the store open'));
  });
  await until(() => engine.closed);
  assert.deepEqual((await env.locks.query()).held, []);
  assert.deepEqual([engine.getSnapshot().upgradeRequired, engine.getSnapshot().superseded], [true, true]);
  assert.deepEqual(env.events.filter(({ name }) => ['sync-upgrade', 'sync-leader'].includes(name)).map(({ name, props }) => `${name}:${props.outcome}`),
    ['sync-leader:acquired', 'sync-upgrade:superseded', 'sync-leader:released']);
  assert.equal(env.channels.messages.at(-1).data.type, 'bye');
  await assert.rejects(engine.commit('self/probe', card('card0002')), (error) => error instanceof CommitError && error.kind === 'store');
  assert.deepEqual(env.failures, []);
});

test('a delayed hello cannot number work after the account credential generation changes', async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  await engine.commit('self/probe', card());
  const before = structuredClone(engine.device.activeReplica.entries());
  let complete;
  const request = env.transport.request.bind(env.transport);
  env.transport.request = async (endpoint, ...args) => {
    const result = await request(endpoint, ...args);
    if (endpoint === 'hello') return new Promise((resolve) => { complete = () => resolve(result); });
    return result;
  };
  const sending = engine.send();
  await until(() => complete);
  await engine.write(null, (device) => { device.meta.authGeneration = (device.meta.authGeneration ?? 0) + 1; });
  complete(); await sending;
  assert.deepEqual(engine.device.activeReplica.entries(), before);
  assert.equal(env.requests.filter(({ endpoint }) => endpoint === 'push').length, 0);
  engine.close();
});

test('a delayed hello cannot number work after the local server epoch changes', async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A');
  await engine.commit('self/probe', card());
  const before = structuredClone(engine.device.activeReplica.entries());
  const next = engine.device.activeReplica.meta.nextN;
  let complete;
  const request = env.transport.request.bind(env.transport);
  env.transport.request = async (endpoint, ...args) => {
    const result = await request(endpoint, ...args);
    if (endpoint === 'hello') return new Promise((resolve) => { complete = () => resolve(result); });
    return result;
  };
  const sending = engine.send();
  await until(() => complete);
  await engine.write(null, (device) => { device.activeReplica.meta.serverEpoch = 'ep-2'; });
  complete(); await sending;
  assert.deepEqual(engine.device.activeReplica.entries(), before);
  assert.equal(engine.device.activeReplica.meta.nextN, next);
  assert.equal(env.requests.filter(({ endpoint }) => endpoint === 'push').length, 0);
  env.transport.request = request;
  await engine.send();
  assert.equal(env.requests.filter(({ endpoint }) => endpoint === 'push').length, 1);
  engine.close();
});

test('offline reload boots confirmed views and held work entirely from IndexedDB without network', async () => {
  const env = environment();
  let engine = await BrowserSyncEngine.open(env.options);
  const result = await engine.commit('self/probe', card(), { hold: true });
  const expected = engine.observe('self/probe').getSnapshot();
  engine.close();
  env.options.navigator.onLine = false;
  env.transport.request = () => assert.fail('offline boot used network');
  engine = await BrowserSyncEngine.open(env.options);
  assert.deepEqual(engine.observe('self/probe').getSnapshot(), expected);
  assert.equal(engine.device.activeReplica.entry(result.localIds[0]).state, 'held');
  await engine.start();
  assert.equal(engine.device.activeReplica.entry(result.localIds[0]).state, 'ready');
  assert.equal(env.requests.length, 0);
  engine.close();
});

test('durable commits publish stable React snapshots; exceptions publish no partial view', async () => {
  const env = environment(), engine = await BrowserSyncEngine.open(env.options);
  const observation = engine.observe('self/probe');
  assert.equal(observation.getSnapshot(), observation.getSnapshot());
  const snapshots = [];
  const unsubscribe = observation.subscribe(() => snapshots.push(observation.getSnapshot()));
  await engine.commit('self/probe', card(), { hold: true });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].drawn[0].f.title[0], 'secret');
  assert.deepEqual(snapshots[0].stored, []);
  assert.equal(Object.isFrozen(snapshots[0].drawn), true);
  const before = observation.getSnapshot();
  await assert.rejects(engine.commit('self/probe', () => { throw new Error('private content'); }));
  assert.equal(observation.getSnapshot(), before);
  assert.equal(snapshots.length, 1);
  unsubscribe(); engine.close();
});

test('a store that cannot commit is a store failure reported as storage; a transaction body’s own throw passes to its caller unreported', async () => {
  const env = environment(), engine = await BrowserSyncEngine.open(env.options);
  const refusal = new Error('the product refuses this');
  await assert.rejects(engine.commit('self/probe', () => { throw refusal; }), (error) => error === refusal);
  await assert.rejects(engine.commit('self/probe', [{ op: 'nope', t: 'card', id: 'card0002' }]),
    (error) => error instanceof CommitError && error.kind === 'malformed');
  const bug = new TypeError('a step broke');
  await assert.rejects(engine.write(null, () => { throw bug; }), (error) => error === bug);
  assert.deepEqual(env.failures, []);
  const quota = new DOMException('quota', 'QuotaExceededError');
  engine.store.transact = () => Promise.reject(quota);
  await assert.rejects(engine.commit('self/probe', card('card0003')),
    (error) => error instanceof CommitError && error.kind === 'store' && error.cause === quota);
  assert.deepEqual(env.failures, ['storage']);
  engine.close();
});

test('the engine’s own release, which no caller hears, reports its broken step as storage, and a store failure once', async () => {
  const env = environment(), engine = await open(env);
  const entries = Replica.prototype.entries;
  const releaseDue = async (failures) => {
    env.timers.tasks.get(engine.holdTimer).callback();
    await until(() => env.failures.length === failures);
    for (let turn = 0; turn < 20; turn++) await tick();
  };
  try {
    await engine.commit('self/probe', card('card0001'), { hold: true });
    Replica.prototype.entries = function () { throw new TypeError('a release broke'); };
    await releaseDue(1);
    Replica.prototype.entries = entries;
    assert.deepEqual(env.failures, ['storage']);
    await engine.commit('self/probe', card('card0002'), { hold: true });
    const quota = new DOMException('quota', 'QuotaExceededError');
    engine.store.transact = () => Promise.reject(quota);
    await releaseDue(2);
    assert.deepEqual(env.failures, ['storage', 'storage']);
  } finally { Replica.prototype.entries = entries; engine.close(); }
});

test('dismissing a notice the active replica does not hold answers false, changes nothing and reports nothing', async () => {
  const env = environment(), engine = await open(env);
  const before = (await engine.store.read()).device.toJSON();
  const revision = engine.revision;
  assert.equal(await engine.dismissNotice('notice:gone/0'), false);
  assert.deepEqual({ device: (await engine.store.read()).device.toJSON(), revision: engine.revision, failures: env.failures },
    { device: before, revision, failures: [] });
  engine.close();
});

test('a store failure while sending or pulling reports storage once and never as transport', async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  await engine.commit('self/probe', card());
  const transact = engine.store.transact.bind(engine.store), quota = new DOMException('quota', 'QuotaExceededError');
  engine.store.transact = (change, options) => (options?.readonly ? transact(change, options) : Promise.reject(quota));
  await engine.send();
  engine.kickPull(); await engine.pull();
  assert.deepEqual(env.failures, ['storage', 'storage']);
  engine.close();
});

test('a burst of writes in one minute never starves the transport failure that follows it', async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  for (let n = 0; n < 40; n++) await engine.commit('self/probe', [{ op: 'put', t: 'day', id: `2026-10-${String(n % 28 + 1).padStart(2, '0')}`, present: true, f: { score: n % 11 } }]);
  assert.ok(env.events.filter(({ name }) => name === 'sync-writer').length > 0);
  env.transport.request = async () => { throw new Error('offline'); };
  await engine.send();
  assert.deepEqual(env.failures, ['transport']);
  engine.close();
});

test('an observation lives while a hold is unreleased: a released hold hears nothing more, and the last release drops the scope', async () => {
  const env = environment(), engine = await open(env), tree = 'tree/b_00000001';
  const tag = (id, seq) => row({ t: 'tag', id, life: ['alive', st(seq)], born: st(seq), seq });
  const store = (id, seq) => engine.write(null, (device) => device.activeReplica.putConfirmed(tree, tag(id, seq)), [tree]);
  try {
    const first = engine.observe(tree), second = engine.observe(tree);
    const heard = [0, 0];
    first.subscribe(() => heard[0]++);
    second.subscribe(() => heard[1]++);
    await store('oak', 1);
    assert.ok(heard[0] > 0 && heard[1] > 0);
    first.release(); first.release();
    const [before, other] = heard;
    await store('ash', 2);
    assert.equal(heard[0], before);
    assert.ok(heard[1] > other);
    assert.deepEqual(second.getSnapshot().drawn.map(({ id }) => id), ['ash', 'oak']);
    assert.equal(engine.views.has(tree), true);
    second.release();
    assert.equal(engine.views.has(tree), false);
    const silent = [...heard];
    await store('elm', 3);
    assert.deepEqual(heard, silent);
    const third = engine.observe(tree);
    assert.deepEqual(third.getSnapshot().drawn.map(({ id }) => id), ['ash', 'elm', 'oak']);
    third.release();
  } finally { engine.close(); }
});

test('every publication reads every scope the replica holds: a tree pulled unobserved is whole at its first observation', async () => {
  const env = environment(), tree = 'tree/b_00000001';
  const tags = ['ash', 'elm', 'oak'].map((id, index) => row({ t: 'tag', id, life: ['alive', st(1)], born: st(1), seq: index + 2 }));
  env.state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), 'tree:b_00000001': treeScope('A', 'b_00000001') },
    rows: { 'acct:A/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1)], born: st(1), seq: 1 })], 'tree:b_00000001': tags },
  }));
  const engine = await open(env);
  try {
    env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
    for (let round = 0; round < 3; round++) { engine.kickPull(); await engine.pull(); }
    assert.equal(engine.views.has(tree), false);
    const view = engine.observe(tree).getSnapshot();
    assert.deepEqual({ loaded: view.loaded, drawn: view.drawn.map(({ id }) => id) }, { loaded: true, drawn: ['ash', 'elm', 'oak'] });
  } finally { engine.close(); }
});

test('the engine snapshot says the connection: offline from the browser, unreachable after a request failed, online once one answers, in every tab', async () => {
  const env = environment(), engine = await open(env), other = await peer(env);
  try {
    env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
    const told = [];
    engine.observeEngine(() => told.push(engine.getSnapshot().connection));
    assert.equal(engine.getSnapshot().connection, 'online');
    const request = env.transport.request.bind(env.transport);
    env.transport.request = async () => { throw new Error('offline'); };
    engine.kickPull(); await engine.pull();
    assert.equal(engine.getSnapshot().connection, 'unreachable');
    await until(() => other.getSnapshot().connection === 'unreachable');
    env.transport.request = async (endpoint, body) => (endpoint === 'pull' ? { response: { status: 503, body: { retryAfterMs: 0 } }, timing: {} } : request(endpoint, body));
    engine.pullWait.until = 0; engine.kickPull(); await engine.pull();
    assert.equal(engine.getSnapshot().connection, 'unreachable');
    env.transport.request = request;
    engine.pullWait.until = 0; engine.kickPull(); await engine.pull();
    assert.equal(engine.getSnapshot().connection, 'online');
    await until(() => other.getSnapshot().connection === 'online');
    engine.setOnline(false);
    assert.equal(engine.getSnapshot().connection, 'offline');
    engine.setOnline(true);
    assert.equal(engine.getSnapshot().connection, 'online');
    assert.deepEqual(told.filter((state, index) => state !== told[index - 1]), ['unreachable', 'online', 'offline', 'online']);
  } finally { other.close(); engine.close(); }
});

test('an observation names the drawn records an outbox entry still changes and counts its scope\'s entries by state', async () => {
  const env = environment(), engine = await open(env);
  try {
    env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
    const view = engine.observe('self/probe');
    await engine.commit('self/probe', card('card0001'), { hold: true });
    await engine.commit('self/probe', card('card0002'));
    let snapshot = view.getSnapshot();
    assert.deepEqual(snapshot.pending.map(({ id }) => id), ['card0001', 'card0002']);
    assert.ok(snapshot.pending.every((record, index) => record === snapshot.drawn[index]));
    assert.deepEqual(snapshot.outbox, { held: 1, ready: 1, sent: 0, acked: 0 });
    await engine.release(engine.device.activeReplica.entries().find((entry) => entry.state === 'held').localId);
    await engine.send(); await until(() => !engine.sending);
    assert.deepEqual(view.getSnapshot().outbox, { held: 0, ready: 0, sent: 0, acked: 2 });
    engine.kickPull(); await engine.pull();
    snapshot = view.getSnapshot();
    assert.deepEqual(snapshot.pending, []);
    assert.deepEqual(snapshot.outbox, { held: 0, ready: 0, sent: 0, acked: 0 });
    assert.deepEqual(snapshot.drawn.map(({ id, seq }) => [id, typeof seq]), [['card0001', 'number'], ['card0002', 'number']]);
  } finally { engine.close(); }
});

test('undo offers are the held gestures, each with its own deadline and records, until undone or released', async () => {
  const env = environment(), engine = await BrowserSyncEngine.open(env.options);
  const observation = engine.observe('self/probe');
  const first = await engine.commit('self/probe', card('card0001'), { hold: true });
  env.timers.advance(4000);
  const second = await engine.commit('self/probe', card('card0002'), { hold: true });
  await engine.commit('self/probe', card('card0003'));
  const gesture = (result) => engine.device.activeReplica.entry(result.localIds[0]).gestureId;
  assert.deepEqual(observation.getSnapshot().undoOffers, [
    { id: gesture(first), releaseAt: 1000 + 9000, records: [{ t: 'card', id: 'card0001' }] },
    { id: gesture(second), releaseAt: 5000 + 9000, records: [{ t: 'card', id: 'card0002' }] },
  ]);
  assert.equal(await engine.undo(gesture(second)), true);
  assert.deepEqual(observation.getSnapshot().undoOffers.map((offer) => offer.id), [gesture(first)]);
  await engine.write('sync-release', (device, ctx) => releaseDue(device.activeReplica, engine.registry, ctx.ended, 1000 + 9000));
  assert.deepEqual(observation.getSnapshot().undoOffers, []);
  engine.close();
});

test('the first tab releases held work; a second tab preserves the current Undo window', async () => {
  const env = environment(), a = await open(env);
  const result = await a.commit('self/probe', card(), { hold: true });
  const b = await BrowserSyncEngine.open(env.options);
  await b.start();
  await tick();
  assert.equal(b.device.activeReplica.entry(result.localIds[0]).state, 'held');
  assert.equal(await b.undo(a.device.activeReplica.entry(result.localIds[0]).gestureId), true);
  await until(() => a.device.activeReplica.outbox.length === 0);
  a.close(); await until(() => b.leader); b.close();
});

test('same-account refreshes preserve holds until Undo or their original deadline', async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  const first = await engine.commit('self/probe', card(), { hold: true });
  const held = engine.device.activeReplica.entry(first.localIds[0]);
  const deadline = held.releaseAt;
  for (let n = 0; n < 3; n++) {
    assert.equal((await engine.signIn('A')).complete, true);
    await engine.send();
    assert.equal(engine.device.activeReplica.entry(first.localIds[0]).state, 'held');
    assert.equal(engine.device.activeReplica.entry(first.localIds[0]).releaseAt, deadline);
  }
  assert.equal(env.requests.filter(({ endpoint }) => endpoint === 'push').length, 0);
  assert.equal(await engine.undo(held.gestureId), true);
  const second = await engine.commit('self/probe', card('card0002'), { hold: true });
  env.timers.advance(engine.device.activeReplica.entry(second.localIds[0]).releaseAt - env.timers.time - 1);
  await engine.signIn('A'); await engine.send();
  assert.equal(engine.device.activeReplica.entry(second.localIds[0]).state, 'held');
  env.timers.advance(1);
  await until(() => engine.device.activeReplica.entry(second.localIds[0]).state === 'ready');
  await engine.send();
  assert.equal(engine.device.activeReplica.entry(second.localIds[0]).state, 'acked');
  engine.close();
});

function lifecycle(env) {
  env.options.window = new EventTarget();
  env.options.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  return (type) => env.options.window.dispatchEvent(Object.assign(new Event(type), { persisted: true }));
}

test('persisted restore reopens storage and coordination and retains observations and listeners', async () => {
  const env = environment(), dispatch = lifecycle(env), engine = await open(env);
  const observation = engine.observe('self/probe'), events = [], seen = [];
  observation.subscribe(() => seen.push(observation.getSnapshot()));
  engine.onEvent((event) => events.push(event.event));
  const oldStore = engine.store, oldCoordination = engine.coordination;
  dispatch('pagehide');
  assert.equal(engine.closed, true);
  assert.equal(oldStore.closed, true);
  assert.equal(oldCoordination.closed, true);
  const writer = await BrowserSyncEngine.open({ ...env.options, window: null, document: null });
  await writer.start();
  await writer.commit('self/probe', card());
  env.options.navigator.onLine = false;
  dispatch('pageshow'); await engine.restoring;
  assert.equal(engine.closed, false);
  assert.equal(engine.online, false);
  assert.equal(engine.observe('self/probe').getSnapshot(), observation.getSnapshot());
  assert.equal(observation.getSnapshot().drawn[0].id, 'card0001');
  assert.equal(seen.at(-1), observation.getSnapshot());
  assert.deepEqual(events, ['suspended', 'restored']);
  writer.close(); await until(() => engine.leader);
  await engine.commit('self/probe', card('card0002'));
  assert.equal(observation.getSnapshot().drawn.length, 2);
  engine.close();
});

test('failed restore reports storage failure, retains local work and permits a later restore', async () => {
  const env = environment(), dispatch = lifecycle(env), engine = await open(env);
  await engine.commit('self/probe', card());
  const events = []; engine.onEvent((event) => events.push(event.event));
  dispatch('pagehide');
  const reopen = engine.store.reopen;
  engine.store.reopen = async () => { throw new Error('storage blocked'); };
  dispatch('pageshow'); await assert.rejects(engine.restoring, /storage blocked/);
  assert.equal(engine.closed, true);
  assert.equal(engine.observe('self/probe').getSnapshot().drawn.length, 1);
  assert.ok(events.includes('restoreFailed'));
  assert.ok(env.failures.includes('storage'));
  engine.store.reopen = reopen;
  dispatch('pageshow'); await engine.restoring;
  assert.equal(engine.closed, false);
  assert.equal(engine.observe('self/probe').getSnapshot().drawn.length, 1);
  engine.close();
});

test('a write while the page is suspended waits for the restore and lands in the reopened store, the views standing meanwhile', async () => {
  const env = environment(), dispatch = lifecycle(env), engine = await open(env);
  await engine.commit('self/probe', card());
  const observation = engine.observe('self/probe');
  const held = observation.getSnapshot();
  dispatch('pagehide');
  let landed = false;
  const writing = engine.commit('self/probe', card('card0002')).then((outcome) => { landed = true; return outcome; });
  for (let turn = 0; turn < 20; turn++) await tick();
  assert.deepEqual({ landed, closed: engine.closed, snapshot: observation.getSnapshot() === held,
    drawn: observation.getSnapshot().drawn.map((record) => record.id) }, { landed: false, closed: true, snapshot: true, drawn: ['card0001'] });
  dispatch('pageshow'); await engine.restoring;
  const outcome = await writing;
  assert.deepEqual({ localIds: outcome.localIds.length, drawn: observation.getSnapshot().drawn.map((record) => record.id).sort(),
    stored: (await engine.store.read()).device.activeReplica.entries().length, failures: env.failures },
  { localIds: 1, drawn: ['card0001', 'card0002'], stored: 2, failures: [] });
  engine.close();
});

test('a write waiting on a restore that fails fails as the store; one issued after it fails at once, reported, and the next restore takes the writes after it', async () => {
  const env = environment(), dispatch = lifecycle(env), engine = await open(env);
  dispatch('pagehide');
  const waiting = engine.commit('self/probe', card());
  const reopen = engine.store.reopen;
  engine.store.reopen = async () => { throw new Error('storage blocked'); };
  dispatch('pageshow');
  await assert.rejects(engine.restoring, /storage blocked/);
  await assert.rejects(waiting, (error) => error instanceof CommitError && error.kind === 'store');
  assert.deepEqual(env.failures, ['storage']);
  const settled = (promise) => promise.then(() => 'landed', (error) => `${error.constructor.name}:${error.kind}`);
  const given = [settled(engine.commit('self/probe', card('card0002'))), settled(engine.signIn('A'))];
  let answers = null;
  Promise.all(given).then((each) => { answers = each; });
  for (let turn = 0; turn < 5; turn++) await tick();
  assert.deepEqual({ answers, failures: env.failures }, { answers: ['CommitError:store', 'CommitError:store'], failures: ['storage', 'storage', 'storage', 'auth'] });
  engine.store.reopen = reopen;
  dispatch('pageshow');
  const later = engine.commit('self/probe', card('card0003'));
  await engine.restoring;
  assert.equal((await later).localIds.length, 1);
  assert.deepEqual(engine.device.activeReplica.entries().map((entry) => entry.intent.d[0].id), ['card0003']);
  engine.close();
});

test('a write waiting on a suspended page fails as the store when the engine closes for good', async () => {
  const env = environment(), dispatch = lifecycle(env), engine = await open(env);
  dispatch('pagehide');
  const waiting = engine.commit('self/probe', card());
  engine.close();
  await assert.rejects(waiting, (error) => error instanceof CommitError && error.kind === 'store');
  assert.deepEqual(env.failures, []);
});

const seatMoves = {
  'signs A out and B in': { seat: async (engine, env) => { env.transport.account = 'A'; await engine.signIn('A'); },
    move: async (other, env) => { await other.finishSignOut({ choice: 'keep' }); env.transport.account = 'B'; await other.signIn('B'); } },
  'binds the anon replica in place to B': { seat: (engine) => engine.commit('self/probe', card('card0009')),
    move: async (other, env) => { env.transport.account = 'B'; assert.equal((await other.signIn('B')).complete, true); } },
};
for (const [name, { seat, move }] of Object.entries(seatMoves)) test(`a commit and an act the back/forward cache held while another tab ${name} land in no seat, tell not-writable and report nothing`, async () => {
  const env = environment(), dispatch = lifecycle(env), engine = await open(env);
  await seat(engine, env);
  const replica = engine.activeReplica();
  dispatch('pagehide');
  const held = [engine.commit('self/probe', card('card0101')), engine.commitAct([{ scope: 'self/probe', changes: card('card0102') }])];
  const other = await BrowserSyncEngine.open({ ...env.options, window: null, document: null });
  await other.start();
  await move(other, env);
  other.close();
  const told = { events: env.events.length, failures: env.failures.length };
  dispatch('pageshow'); await engine.restoring;
  const outcomes = await Promise.all(held.map((write) => write.then(() => 'landed', (error) => error.constructor.name)));
  const landed = (await engine.store.read()).device.replicas
    .flatMap((each) => each.entries().map((entry) => entry.intent.d[0].id)).filter((id) => ['card0101', 'card0102'].includes(id));
  assert.deepEqual({ outcomes, landed, account: engine.getSnapshot().account, sameReplica: engine.activeReplica() === replica,
    commits: env.events.slice(told.events).filter((event) => event.name === 'sync-commit'), failures: env.failures.slice(told.failures) },
  { outcomes: ['ReplicaChanged', 'ReplicaChanged'], landed: [], account: 'B', sameReplica: name.includes('in place'),
    commits: [{ name: 'sync-commit', props: { outcome: 'not-writable' } }, { name: 'sync-commit', props: { outcome: 'not-writable' } }], failures: [] });
  engine.close();
});

test('an explicit close during a stalled restore cannot resurrect coordination or storage', async () => {
  const env = environment(), dispatch = lifecycle(env), engine = await open(env);
  dispatch('pagehide');
  const reopened = await engine.store.reopen();
  let resolve;
  engine.store.reopen = () => new Promise((done) => { resolve = done; });
  dispatch('pageshow'); const restoring = engine.restoring;
  engine.close(); resolve(reopened); await restoring;
  assert.equal(engine.closed, true);
  assert.equal(reopened.closed, true);
  assert.equal(engine.coordination.closed, true);
});

test('hello, push and pull converge the persisted browser views with the reference server', async () => {
  const env = environment(), engine = await open(env);
  await engine.commit('self/probe', card());
  env.transport.account = 'A';
  assert.equal((await engine.signIn('A')).complete, true);
  await until(() => engine.leader);
  await engine.send();
  assert.equal(engine.device.activeReplica.outbox[0].state, 'acked');
  await engine.pull();
  assert.deepEqual(engine.device.activeReplica.outbox, []);
  assert.equal(engine.device.activeReplica.confirmedRows('self/probe')[0].f.title[0], 'secret');
  assert.equal(engine.observe('self/probe').getSnapshot().firstPullComplete, true);
  assert.deepEqual(env.requests.map(({ endpoint }) => endpoint), ['hello', 'hello', 'push', 'pull']);
  assert.ok(env.persisted >= 1);
  engine.close();
});

test('auth loss or a foreign principal pauses sync and changes no pulled data', async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A');
  await until(() => engine.leader);
  await engine.commit('self/probe', card()); await engine.send(); await engine.pull();
  const before = structuredClone(engine.device.activeReplica.confirmed);
  env.transport.account = 'B';
  engine.kickPull(); await engine.pull();
  assert.equal(engine.device.activeReplica.meta.authPaused, true);
  assert.deepEqual(engine.device.activeReplica.confirmed, before);
  env.transport.account = 'A'; await engine.signIn('A');
  assert.equal(engine.device.activeReplica.meta.authPaused, false);
  assert.equal(engine.live.k, 0);
  engine.close();
});

test('426 broadcasts an upgrade stop to every tab and still permits offline local commits', async () => {
  const env = environment(), a = await open(env), b = await BrowserSyncEngine.open(env.options);
  await b.start();
  env.transport.response = async () => ({ response: { status: 426 }, timing: {} });
  await a.signIn('A');
  await until(() => b.upgradeRequired);
  assert.equal(a.getSnapshot().upgradeRequired, true);
  assert.equal(b.getSnapshot().upgradeRequired, true);
  await b.commit('self/probe', card());
  assert.equal(b.device.activeReplica.outbox.length, 1);
  a.close(); b.close();
});

test('sign-in pins Add/Discard decisions and sign-out Keep isolates dormant accounts', async () => {
  const env = environment(), engine = await open(env);
  await engine.commit('self/probe', card());
  env.transport.account = 'A';
  const response = { status: 200, body: { as: 'A', holdsRecords: { probe: true }, epoch: 'ep-1', serverTime: 1000, schema: 1, minSchema: 1 } };
  env.transport.response = async () => ({ response, timing: { send: { wall: 1000, mono: 1000, boot: 'test' }, recv: { wall: 1000, mono: 1000, boot: 'test' } } });
  let result = await engine.signIn('A');
  assert.equal(result.complete, false);
  assert.equal(engine.device.activeReplica.meta.state, 'anon');
  assert.equal(env.requests.filter(({ endpoint }) => endpoint === 'push').length, 0);
  const old = result.due[0].counted;
  await engine.commit('self/probe', card('card0002'));
  result = await engine.signIn('A', { decisions: { probe: 'add' }, counted: { probe: old } });
  assert.equal(result.complete, false);
  result = await engine.signIn('A', { decisions: { probe: 'add' }, counted: { probe: result.due[0].counted } });
  assert.equal(result.complete, true);
  await engine.finishSignOut({ choice: 'keep' });
  assert.equal(engine.device.dormantOf('A').outbox.length, 2);
  assert.equal(engine.device.activeReplica.meta.state, 'anon');
  assert.deepEqual(engine.device.dormantOf('A').confirmed, {});
  engine.close();
});

const deviceDraftWork = (product, rows) => product === 'probe' ? Object.keys(rows).filter((key) => key === 'rack' || key.startsWith('picture:')) : [];

const bindingChanges = {
  'a sign-in to a new replica': { before: async () => {}, change: (engine) => engine.signIn('A'), keepsReplica: false },
  'a sign-in that binds the anon replica in place': { before: (engine) => engine.commit('self/probe', card('card0009')),
    change: (engine) => engine.signIn('A'), keepsReplica: true },
  'a sign-out': { before: (engine) => engine.signIn('A'), change: (engine) => engine.finishSignOut({ choice: 'keep' }), keepsReplica: false },
};
for (const [name, { before, change, keepsReplica }] of Object.entries(bindingChanges)) test(`an act planned before ${name} throws ReplicaChanged, writes nothing, reports no failure and tells its commit not-writable, and one planned after it commits`, async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A';
  await before(engine);
  const planned = { replica: engine.activeReplica(), binding: engine.activeBinding() };
  assert.equal((await change(engine)).complete, true);
  assert.deepEqual({ sameReplica: engine.activeReplica() === planned.replica, sameBinding: engine.activeBinding() === planned.binding },
    { sameReplica: keepsReplica, sameBinding: false });
  const stored = (await engine.store.read()).device.toJSON();
  const told = { events: env.events.length, failures: env.failures.length };
  let prepared = 0;
  await assert.rejects(engine.commitAct(() => { prepared++; return { request: { scopes: ['self/probe'], hold: false }, value: card() }; },
    (changes) => ({ changes }), { binding: planned.binding }), ReplicaChanged);
  assert.deepEqual({ prepared, device: (await engine.store.read()).device.toJSON(), events: env.events.slice(told.events), failures: env.failures.slice(told.failures) },
    { prepared: 0, device: stored, events: [{ name: 'sync-commit', props: { outcome: 'not-writable' } }], failures: [] });
  const queued = engine.device.activeReplica.entries().map((entry) => entry.localId);
  const { outcome } = await engine.commitAct([{ scope: 'self/probe', changes: card() }], {}, { binding: engine.activeBinding() });
  assert.deepEqual(engine.device.activeReplica.entries().map((entry) => entry.localId), [...queued, ...outcome.segments[0].localIds]);
  engine.close();
});

for (const [name, { before, change, keepsReplica }] of Object.entries(bindingChanges)) for (const ending of keepsReplica ? ['answered'] : ['answered', 'aborted'])
  test(`a pull ${ending} after ${name}, and the frame deferred behind it, apply nothing, pause nothing and count as no failure`, async () => {
    const env = environment(), engine = await open(env), tree = 'tree/b_00000001';
    env.transport.account = 'A';
    await before(engine);
    await engine.subscribe(tree);
    const transport = env.transport.request.bind(env.transport);
    let answer;
    env.transport.request = async (endpoint, body, options) => {
      const reply = await transport(endpoint, body, options);
      if (endpoint !== 'pull') return reply;
      return new Promise((resolve, reject) => {
        answer = () => resolve(reply);
        if (ending === 'aborted') options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    };
    const pulling = engine.pull();
    await until(() => answer);
    env.transport.request = transport;
    await engine.receiveFrame({ op: 'not-found', scope: tree, as: engine.device.activeReplica.meta.account ?? null });
    assert.equal(engine.deferredFrames.has(tree), true);
    const told = env.failures.length;
    assert.equal((await change(engine)).complete, true);
    const stored = (await engine.store.read()).device.toJSON();
    answer(); await pulling;
    assert.deepEqual({ device: (await engine.store.read()).device.toJSON(), failures: env.failures.slice(told), backoff: engine.pullWait.k, due: engine.pullWait.due(env.timers.time) },
      { device: stored, failures: [], backoff: 0, due: true });
    engine.close();
  });

for (const [name, { before, change }] of Object.entries(bindingChanges)) test(`a frame that lands after ${name} applies nothing and pauses nothing`, async () => {
  const env = environment(), engine = await open(env), tree = 'tree/b_00000001';
  env.transport.account = 'A';
  await before(engine);
  await engine.subscribe(tree);
  const write = engine.write.bind(engine);
  let landing;
  engine.write = (operation, ...rest) => {
    const written = write(operation, ...rest);
    if (['sync-signin', 'sync-signout'].includes(operation))
      landing ??= engine.receiveFrame({ op: 'not-found', scope: tree, as: engine.device.activeReplica.meta.account ?? null });
    return written;
  };
  assert.equal((await change(engine)).complete, true);
  await landing;
  assert.deepEqual({ authPaused: engine.device.activeReplica.meta.authPaused, known: engine.device.activeReplica.known, failures: env.failures },
    { authPaused: false, known: {}, failures: [] });
  engine.close();
});

test('a sign-in another tab completes in place stops the leader\'s socket, so a frame that socket carried lands nowhere', async () => {
  const env = environment(), tree = 'tree/b_00000001';
  env.state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), 'tree:b_00000001': treeScope('A', 'b_00000001') },
    rows: { 'acct:A/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1)], born: st(1), seq: 1 })],
      'tree:b_00000001': [row({ t: 'meta', id: 'meta', f: { visibility: ['public', st(1)] }, seq: 1 })] },
  }));
  const leader = await open(env), tab = await peer(env);
  await leader.subscribe(tree);
  await leader.pull();
  const socket = env.sockets.at(-1);
  socket.readyState = 1; socket.onopen();
  const deliver = socket.onmessage;
  await tab.commit('self/probe', card('card0009'));
  env.transport.account = 'B';
  assert.equal((await tab.signIn('B')).complete, true);
  await until(() => leader.device.activeReplica.meta.state === 'bound');
  deliver({ data: JSON.stringify({ op: 'not-found', scope: tree, as: null }) });
  await until(() => !leader.live.draining);
  assert.deepEqual({ sameReplica: leader.activeReplica() === tab.activeReplica(), followedBy: leader.live.socket === socket ? 'the old socket' : 'another',
    oldSocket: socket.readyState, authPaused: leader.device.activeReplica.meta.authPaused, known: leader.device.activeReplica.known },
  { sameReplica: true, followedBy: 'another', oldSocket: 3, authPaused: false, known: {} });
  tab.close(); leader.close();
});

test('an act planned before a re-identify of the active replica commits: the binding outlives the replica\'s id', async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A';
  await engine.signIn('A');
  const planned = { replica: engine.activeReplica(), binding: engine.activeBinding() };
  await engine.write(null, (device, ctx) => reidentify(device.activeReplica, ctx));
  assert.deepEqual({ sameReplica: engine.activeReplica() === planned.replica, sameBinding: engine.activeBinding() === planned.binding },
    { sameReplica: false, sameBinding: true });
  const { outcome } = await engine.commitAct([{ scope: 'self/probe', changes: card() }], {}, { binding: planned.binding });
  assert.deepEqual(engine.device.activeReplica.entries().map((entry) => entry.localId), outcome.segments[0].localIds);
  engine.close();
});

test('sign-in carries a device-only draft into an empty account and reopening retains it once', async () => {
  const env = environment();
  const options = { ...env.options, pendingDeviceWork: deviceDraftWork };
  const engine = await BrowserSyncEngine.open(options);
  const draft = { day: '2026-10-07', document: { body: 'anonymous writing', mood: null, energy: null, source: 'typed' } };
  await engine.commit('self/probe', [], { local: { rack: draft } });
  assert.deepEqual(engine.device.activeReplica.entries(), []);
  env.transport.account = 'A';
  assert.deepEqual(await engine.signIn('A'), { complete: true, due: [] });
  const stored = (await engine.store.read()).device;
  assert.deepEqual(stored.activeReplica.deviceRows('probe'), { rack: draft });
  assert.equal(stored.replicas.filter((replica) => replica.device.probe?.rack).length, 1);
  engine.close();
  const reopened = await BrowserSyncEngine.open(options);
  assert.deepEqual(reopened.device.activeReplica.deviceRows('probe'), { rack: draft });
  reopened.close();
});

test('sign-in lets the product retain both device-only drafts when a dormant account owns the same key', async () => {
  const env = environment();
  const calls = [];
  const options = { ...env.options, pendingDeviceWork: deviceDraftWork,
    adoptDeviceRows: (product, incoming, kept) => {
      calls.push({ product, incoming: structuredClone(incoming), kept: structuredClone(kept) });
      return { ...incoming, ...kept, 'picture:incoming': incoming.rack };
    } };
  const engine = await BrowserSyncEngine.open(options);
  env.transport.account = 'A';
  await engine.signIn('A');
  const own = { day: '2026-10-07', document: { body: 'account writing', mood: 0, energy: null, source: 'typed' } };
  const incoming = { day: '2026-10-07', document: { body: 'anonymous writing', mood: null, energy: 0, source: 'typed' } };
  await engine.commit('self/probe', [], { local: { rack: own } });
  await engine.finishSignOut({ choice: 'keep' });
  await engine.commit('self/probe', [], { local: { rack: incoming } });
  assert.deepEqual(engine.device.activeReplica.entries(), []);
  const before = (await engine.store.read()).device.toJSON();
  const transact = engine.store.transact.bind(engine.store);
  let aborted = 0;
  engine.store.transact = (change, options) => {
    let adopting = false;
    return transact((device) => {
      const prior = device.activeReplica.meta.state;
      const value = change(device);
      adopting = prior === 'anon' && device.activeReplica.meta.state === 'bound';
      return value;
    }, { ...options, beforeCommit: ({ transaction }) => {
      if (adopting) { aborted++; engine.store.transact = transact; transaction.abort(); }
    } });
  };
  await assert.rejects(engine.signIn('A'), (error) => error instanceof CommitError && error.kind === 'store');
  assert.equal(aborted, 1);
  const interrupted = await BrowserSyncEngine.open(options);
  const retained = (await interrupted.store.read()).device.toJSON();
  assert.deepEqual({ active: retained.active, replicas: retained.replicas }, { active: before.active, replicas: before.replicas });
  interrupted.close();
  calls.length = 0;
  assert.deepEqual(await engine.signIn('A'), { complete: true, due: [] });
  assert.deepEqual(calls, [{ product: 'probe', incoming: { rack: incoming }, kept: { rack: own } }]);
  const stored = (await engine.store.read()).device;
  assert.deepEqual(stored.activeReplica.deviceRows('probe'), { rack: own, 'picture:incoming': incoming });
  assert.equal(stored.replicas.length, 1);
  engine.close();
  const reopened = await BrowserSyncEngine.open(options);
  assert.deepEqual(reopened.device.activeReplica.deviceRows('probe'), { rack: own, 'picture:incoming': incoming });
  reopened.close();
});

test('sign-in refuses a differing pending draft collision without its product merge hook', async () => {
  const env = environment();
  const engine = await BrowserSyncEngine.open({ ...env.options, pendingDeviceWork: deviceDraftWork });
  env.transport.account = 'A';
  await engine.signIn('A');
  await engine.commit('self/probe', [], { local: { rack: { body: 'account writing' } } });
  await engine.finishSignOut({ choice: 'keep' });
  await engine.commit('self/probe', [], { local: { rack: { body: 'anonymous writing' } } });
  const before = (await engine.store.read()).device.toJSON();
  await assert.rejects(engine.signIn('A'), /device-work-adoption-conflict/);
  const after = (await engine.store.read()).device.toJSON();
  assert.deepEqual({ active: after.active, replicas: after.replicas }, { active: before.active, replicas: before.replicas });
  assert.equal(engine.device.activeReplica.meta.state, 'anon');
  engine.close();
});

for (const choice of ['add', 'discard']) test(`sign-in byte-pins a device-only draft and asks again before a stale ${choice}`, async () => {
  const env = environment();
  const engine = await BrowserSyncEngine.open({ ...env.options, pendingDeviceWork: deviceDraftWork });
  const draft = { body: 'first draft' }, changed = { body: 'newer draft' };
  await engine.commit('self/probe', [], { local: { rack: draft } });
  const response = { status: 200, body: { as: 'A', holdsRecords: { probe: true }, epoch: 'ep-1', serverTime: 1000, schema: 1, minSchema: 1 } };
  env.transport.response = async () => ({ response, timing: { send: { wall: 1000, mono: 1000, boot: 'test' }, recv: { wall: 1000, mono: 1000, boot: 'test' } } });
  const expected = (value) => ({ complete: false, due: [{ kind: 'signed-out', product: 'probe', count: {},
    counted: [`device:probe:rack:${hashText(jcs(value))}`], pending: 1 }] });
  const question = await engine.signIn('A');
  assert.deepEqual(question, expected(draft));
  assert.equal(engine.device.activeReplica.meta.state, 'anon');
  assert.equal(env.requests.some(({ endpoint }) => endpoint === 'push'), false);
  await engine.commit('self/probe', [], { local: { rack: changed } });
  const stale = await engine.signIn('A', { decisions: { probe: choice }, counted: { probe: question.due[0].counted } });
  assert.deepEqual(stale, expected(changed));
  assert.deepEqual(engine.device.activeReplica.deviceRows('probe'), { rack: changed });
  const completed = await engine.signIn('A', { decisions: { probe: choice }, counted: { probe: stale.due[0].counted } });
  assert.deepEqual(completed, { complete: true, due: stale.due });
  assert.deepEqual(engine.device.activeReplica.deviceRows('probe'), choice === 'add' ? { rack: changed } : {});
  assert.equal(engine.device.replicas.some((replica) => replica.meta.state === 'anon' && replica.device.probe?.rack), false);
  engine.close();
});

test('process death between push result transactions keeps ackThrough unmoved and resend recovers', async () => {
  const env = environment(); let engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  await engine.commit('self/probe', card('card0001'));
  await engine.commit('self/probe', card('card0002'));
  const original = engine.write.bind(engine); let recorded = 0;
  engine.write = async (...args) => {
    const result = await original(...args);
    if (engine.device.activeReplica.outbox.some((entry) => entry.state === 'acked') && ++recorded === 1) engine.close();
    return result;
  };
  await engine.send();
  engine = await open(env);
  assert.equal(engine.device.activeReplica.meta.ackThrough, 0);
  assert.deepEqual(engine.device.activeReplica.entries().map((entry) => entry.state), ['acked', 'sent']);
  await engine.send(); await engine.pull();
  assert.deepEqual(engine.device.activeReplica.outbox, []);
  assert.equal(engine.device.activeReplica.meta.ackThrough, 2);
  engine.close();
});

test('process death between IndexedDB page chunks leaves the cursor unmoved and reboots into staging', async () => {
  const env = environment(); let engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  const handle = engine.device.activeReplica.storageHandle;
  const rows = Array.from({ length: 130 }, (_, index) => ({ t: 'day', id: `2026-01-${String(index).padStart(2, '0')}`,
    seq: 1, rc: 1, ru: 1, life: ['alive', '1:0:srv'], f: { score: [1, '1:0:srv'] } }));
  const page = { scope: 'self/probe', kind: 'rows', rows, cursor: Cursor.encode({ e: 'ep-1', m: 'live', s: 1 }),
    more: false, seq: 1, digest: scopeDigest(rows) };
  const original = engine.write.bind(engine);
  engine.write = async (...args) => { const result = await original(...args); engine.close(); return result; };
  await assert.rejects(engine.storePages(handle, [{ cursor: null, page }]));
  engine = await open(env);
  assert.equal(engine.device.activeReplica.cursorOf('self/probe').cursor, null);
  assert.equal(engine.device.activeReplica.confirmedRows('self/probe').length, 64);
  await engine.storePages(handle, [{ cursor: null, page }]);
  assert.equal(engine.device.activeReplica.confirmedRows('self/probe').length, 130);
  assert.equal(engine.device.activeReplica.cursorOf('self/probe').digest, page.digest);
  assert.equal(engine.device.activeReplica.cursorOf('self/probe').booted, true);
  engine.close();
});

test('server retry floors and clock-skew backoff survive kicks; sender resends ambiguous work', async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  await engine.commit('self/probe', card());
  env.transport.response = async (endpoint) => endpoint === 'hello' ? readyHello(env) : ({ response: { status: 503, body: { retryAfterMs: 5000 } }, timing: {} });
  await engine.send();
  assert.equal(engine.device.activeReplica.outbox[0].state, 'sent');
  const requests = env.requests.length;
  engine.kick(); await engine.send();
  assert.equal(env.requests.length, requests);
  engine.wait.afterSkew = true; engine.wait.until = 8000;
  engine.kick(); assert.equal(engine.wait.until, 8000);
  engine.close();
});

test('active-replica changes are delivered once to each tab after durable storage changes', async () => {
  const env = environment(), a = await open(env), b = await BrowserSyncEngine.open(env.options);
  await b.start();
  const eventsA = [], eventsB = [];
  a.onEvent((event) => eventsA.push(event)); b.onEvent((event) => eventsB.push(event));
  const previous = a.activeReplica();
  env.transport.account = 'A'; await a.signIn('A');
  await until(() => eventsB.length === 1 && b.activeReplica() === a.activeReplica());
  const expected = { event: 'activeReplicaChanged', previous, replica: a.activeReplica() };
  assert.deepEqual(eventsA, [expected]); assert.deepEqual(eventsB, [expected]);
  assert.equal((await b.store.read()).device.activeReplica.id, expected.replica);
  a.close(); b.close();
});

test('a delayed hello cannot complete an older account sign-in after another sign-in starts', async () => {
  const env = environment(), engine = await open(env);
  let answerFirst, answerSecond;
  env.transport.response = () => new Promise((resolve) => {
    if (!answerFirst) answerFirst = resolve;
    else answerSecond = resolve;
  });
  const first = engine.signIn('A');
  await until(() => Boolean(answerFirst));
  const second = engine.signIn('B');
  await until(() => Boolean(answerSecond));
  const response = (as) => ({ response: { status: 200, body: { as, epoch: 'ep-1', serverTime: 1000,
    schema: 1, minSchema: 1, holdsRecords: { probe: false } } },
    timing: { send: { wall: 1000, mono: 1000, boot: 'test' }, recv: { wall: 1000, mono: 1000, boot: 'test' } } });
  answerSecond(response('B')); assert.equal((await second).complete, true);
  answerFirst(response('A')); assert.deepEqual(await first, { complete: false, superseded: true });
  assert.equal(engine.device.activeReplica.meta.account, 'B');
  engine.close();
});

test('a delayed push result for an old wire replica cannot acknowledge a renumbered entry', async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  await engine.commit('self/probe', card());
  const handle = engine.device.activeReplica.storageHandle;
  const request = await engine.write(null, (device, ctx) => nextPush(device.activeReplica, ctx));
  await engine.write(null, (device, ctx) => reidentify(device.activeReplica, ctx));
  await until(() => engine.leader);
  await engine.write(null, (device, ctx) => nextPush(device.activeReplica, ctx));
  const before = engine.device.toJSON();
  await engine.pushResults(handle, request, { status: 200, body: { as: 'A', epoch: 'ep-1',
    serverTime: 1000, lastN: 1, results: [{ n: 1, s: 'ok', seq: 1 }] } }, {});
  assert.deepEqual(engine.device.toJSON(), before);
  engine.close();
});

for (const first of ['gap', 'success']) test(`a restore learned from ${first} durably replays an acknowledged create before its offline delete`, async () => {
  const env = environment();
  let engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  await engine.commit('self/probe', card());
  await engine.send();
  assert.deepEqual(engine.device.activeReplica.entries().map(({ state }) => state), ['acked']);
  await engine.commit('self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }]);
  env.state = ServerState.empty({ epoch: 'ep-2', accounts: { A: { name: 'A' } } });
  if (first === 'success') {
    await engine.write(null, (device, ctx) => reidentify(device.activeReplica, ctx));
    await until(() => engine.leader);
  }
  const previous = engine.activeReplica();
  let results = 0;
  engine.onPushResult = () => results++;
  await engine.send();
  assert.equal(results, 0, 'results wait for earlier acknowledgements to replay');
  assert.notEqual(engine.activeReplica(), previous);
  assert.equal(engine.device.activeReplica.meta.serverEpoch, 'ep-2');
  assert.deepEqual(engine.device.activeReplica.entries().map(({ state, commitOrder }) => [state, commitOrder]), [['ready', 1], ['ready', 2]]);
  engine.close();
  engine = await open(env);
  await engine.send();
  assert.deepEqual(env.requests.filter(({ endpoint }) => endpoint === 'push').at(-1).request.intents.map(({ d }) => d[0].life[0]), ['alive', 'dead']);
  await engine.pull();
  assert.deepEqual(engine.device.activeReplica.entries(), []);
  assert.deepEqual(engine.device.activeReplica.notices, []);
  assert.deepEqual(engine.device.activeReplica.confirmedRows('self/probe'), []);
  assert.deepEqual(engine.observe('self/probe').getSnapshot().drawn, []);
  assert.deepEqual(env.failures, []);
  engine.close();
});

test('a malformed authenticated gap backs off as a transport failure without altering persisted work', async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  await engine.commit('self/probe', card());
  await engine.send();
  await engine.commit('self/probe', [{ op: 'delete', t: 'card', id: 'card0001' }]);
  await engine.write(null, (device, ctx) => nextPush(device.activeReplica, ctx));
  const before = engine.device.toJSON();
  const expected = new Device(before);
  const hello = readyHello(env);
  expected.activeReplica.takeOffsetSample(hello.response.body.serverTime, hello.timing);
  env.transport.response = (endpoint) => endpoint === 'hello' ? hello : ({ response: { status: 409, body: { as: 'A', serverTime: 1000, error: 'gap' } }, timing: {} });
  await engine.send();
  assert.deepEqual(engine.device.toJSON(), expected.toJSON());
  assert.deepEqual((await engine.store.read()).device.toJSON(), expected.toJSON());
  assert.deepEqual(env.failures, ['transport']);
  assert.equal(engine.wait.due(env.timers.time), false);
  engine.close();
});

test('changed-epoch successes and product receipts commit together, survive reload, and discard only untrusted refusals', async () => {
  const env = environment();
  let engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  await engine.write(null, (device) => { device.activeReplica.meta.serverEpoch = 'ep-1'; });
  for (const id of ['card0001', 'card0002', 'card0003']) await engine.commit('self/probe', card(id));
  const request = await engine.write(null, (device, ctx) => nextPush(device.activeReplica, ctx));
  const handle = engine.device.activeReplica.storageHandle;
  const response = { status: 200, body: { as: 'A', epoch: 'ep-2', serverTime: 1000, lastN: 3, results: [
    { n: 1, s: 'ok', seq: 1 }, { n: 2, s: 'refused', code: 'unknown-record' }, { n: 3, s: 'ok', seq: 2 },
  ] } };
  const before = engine.device.activeReplica.toJSON();
  const timing = { send: { wall: 1000, mono: 1000, boot: 'test' }, recv: { wall: 1000, mono: 1000, boot: 'test' } };
  const receipt = (replica, _ctx, result, body) => {
    replica.deviceRows('probe')[`receipt${result.n}`] = { state: result.s, epoch: body.epoch };
  };
  const crash = new Error('recovery transaction failed');
  engine.onPushResult = (...args) => {
    receipt(...args);
    if (args[2].n === 3) throw crash;
  };
  await assert.rejects(engine.pushResults(handle, request, response, timing), (error) => error === crash);
  const rolledBack = (await engine.store.read()).device.activeReplica.toJSON();
  assert.deepEqual(rolledBack.outbox, before.outbox, 'no success escapes the aborted recovery');
  assert.deepEqual(rolledBack.device, before.device, 'no product receipt escapes the aborted recovery');
  assert.equal(rolledBack.meta.replica, before.meta.replica);
  assert.equal(rolledBack.meta.serverEpoch, 'ep-1');
  engine.close();
  engine = await open(env);
  engine.onPushResult = receipt;
  await engine.pushResults(handle, request, response, timing);
  const recovered = engine.device.toJSON();
  assert.deepEqual(engine.device.activeReplica.entries().map(({ state, resultEpoch }) => [state, resultEpoch]),
    [['acked', 'ep-2'], ['ready', undefined], ['acked', 'ep-2']]);
  assert.deepEqual(engine.device.activeReplica.deviceRows('probe'), {
    receipt1: { state: 'ok', epoch: 'ep-2' }, receipt3: { state: 'ok', epoch: 'ep-2' },
  });
  assert.equal(engine.device.activeReplica.meta.ackThrough, 0);
  assert.equal(engine.device.activeReplica.meta.nextN, 1);
  assert.deepEqual(engine.device.activeReplica.notices, []);
  assert.deepEqual(env.events.filter(({ name }) => name === 'sync-refused'), []);
  engine.close();
  engine = await BrowserSyncEngine.open(env.options);
  assert.deepEqual(engine.device.toJSON(), recovered);
  assert.deepEqual(env.failures, [], 'the receipt callback’s own throw is its caller’s to report');
  engine.close();
});

test('a pull adopting the first epoch between push transactions cannot leave an acknowledgement in another epoch', async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  await engine.commit('self/probe', card());
  const request = await engine.write(null, (device, ctx) => nextPush(device.activeReplica, ctx));
  const handle = engine.device.activeReplica.storageHandle;
  assert.equal(engine.device.activeReplica.meta.serverEpoch, null);
  const write = engine.write.bind(engine);
  let transactions = 0;
  engine.write = async (...args) => {
    if (++transactions === 2) await write(null, (device) => { device.activeReplica.meta.serverEpoch = 'ep-2'; });
    return write(...args);
  };
  let results = 0;
  engine.onPushResult = () => results++;
  await engine.pushResults(handle, request, { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 1000,
    lastN: 1, results: [{ n: 1, s: 'ok', seq: 1 }] } }, {
    send: { wall: 1000, mono: 1000, boot: 'test' }, recv: { wall: 1000, mono: 1000, boot: 'test' },
  });
  assert.equal(results, 1);
  assert.deepEqual(engine.device.activeReplica.entries().map(({ state, resultEpoch }) => [state, resultEpoch]), [['acked', 'ep-1']]);
  assert.equal(engine.device.activeReplica.meta.ackThrough, 0);
  assert.notEqual(engine.activeReplica(), request.replica);
  env.state = ServerState.empty({ epoch: 'ep-2', accounts: { A: { name: 'A' } } });
  await until(() => engine.leader);
  engine.kickPull();
  await engine.pull();
  assert.deepEqual(engine.device.activeReplica.entries().map(({ state }) => state), ['ready']);
  engine.close();
});

test('anonymous replicas reject authenticated scope answers without caching existence or rows', async () => {
  const env = environment(), engine = await open(env);
  await engine.subscribe('tree/b_00000001');
  env.transport.account = 'A';
  await engine.pull();
  assert.equal(engine.device.activeReplica.meta.authPaused, true);
  assert.deepEqual(engine.device.activeReplica.known, {});
  assert.deepEqual(engine.device.activeReplica.confirmedRows('tree/b_00000001'), []);
  engine.close();
});

test('an anon replica answered as an account stays paused through the sign-in, and the sign-out that ends it pulls its open tree, after a reload too', async () => {
  const env = environment(), tree = 'tree/b_00000001';
  env.state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), 'tree:b_00000001': treeScope('A', 'b_00000001') },
    rows: { 'acct:A/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1)], born: st(1), seq: 1 })],
      'tree:b_00000001': [row({ t: 'meta', id: 'meta', f: { visibility: ['public', st(1)] }, seq: 1 }),
        row({ t: 'tag', id: 'oak', life: ['alive', st(1)], born: st(1), f: { label: ['Oak', st(1)] }, seq: 2 })] },
  }));
  const reading = (engine) => ({ state: engine.device.activeReplica.meta.state, authPaused: engine.device.activeReplica.meta.authPaused,
    firstPullComplete: engine.readMetadata(tree).firstPullComplete, rows: engine.device.activeReplica.confirmedRows(tree).map(({ id }) => id) });
  let engine = await open(env);
  await engine.subscribe(tree);
  env.transport.account = 'A';
  await engine.pull();
  assert.deepEqual(reading(engine), { state: 'anon', authPaused: true, firstPullComplete: false, rows: [] });
  assert.equal((await engine.signIn('A')).complete, true);
  assert.equal((await engine.finishSignOut({ choice: 'keep' })).complete, true);
  env.transport.account = null;
  engine.close();
  engine = await open(env);
  await engine.subscribe(tree);
  await engine.pull();
  assert.deepEqual(reading(engine), { state: 'anon', authPaused: false, firstPullComplete: true, rows: ['meta', 'oak'] });
  engine.close();
});

for (const [left, gone] of [['no credential', true], ['another account\'s credential', false]])
  test(`an anon replica a live frame served as an account paused, whose cancelled sign-in's cleanup leaves ${left}, ${gone ? 'resumes' : 'stays paused'}`, async () => {
    const env = environment(), tree = 'tree/b_00000001';
    env.state = new ServerState(serverState({
      scopes: { 'acct:A/probe': productScope('A'), 'tree:b_00000001': treeScope('A', 'b_00000001') },
      rows: { 'acct:A/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1)], born: st(1), seq: 1 })],
        'tree:b_00000001': [row({ t: 'meta', id: 'meta', f: { visibility: ['public', st(1)] }, seq: 1 })] },
    }));
    const cleared = [];
    env.options.credentials = { clear: async (account) => { cleared.push(account); return gone; } };
    const engine = await open(env);
    await engine.commit('self/probe', card());
    await engine.subscribe(tree);
    await engine.pull();
    env.transport.account = 'A';
    assert.equal((await engine.signIn('A')).complete, false);
    await engine.receiveFrame({ op: 'change', scope: tree, as: 'A' });
    assert.deepEqual({ authPaused: engine.device.activeReplica.meta.authPaused, canSync: engine.canSync() }, { authPaused: true, canSync: false });
    await engine.cancelSignIn('A');
    env.transport.account = gone ? null : 'B';
    await engine.cleanupCredentials();
    assert.deepEqual({ cleared, state: engine.device.activeReplica.meta.state, authPaused: engine.device.activeReplica.meta.authPaused,
      canSync: engine.canSync(), owed: engine.device.meta.clearCredential },
    { cleared: ['A'], state: 'anon', authPaused: !gone, canSync: gone, owed: undefined });
    engine.close();
  });

test('cancelling a pending sign-in drops it and owes the account\'s credential in one write, leaving the anon replica active with its work', async () => {
  const env = environment();
  const cleared = [];
  env.options.credentials = { clear: async (account) => { cleared.push(account); return true; } };
  const engine = await open(env);
  await engine.commit('self/probe', card());
  const replica = engine.activeReplica();
  const entries = structuredClone(engine.device.activeReplica.entries());
  assert.deepEqual(await engine.signIn('A'), { complete: false, authPaused: true });
  const writes = [];
  const write = engine.write.bind(engine);
  engine.write = (...args) => { writes.push(args[0]); return write(...args); };
  await engine.cancelSignIn('A');
  assert.deepEqual({ writes, pendingSignIn: engine.device.meta.pendingSignIn, owed: engine.device.meta.clearCredential, cleared,
    replica: engine.activeReplica(), state: engine.device.activeReplica.meta.state, entries: engine.device.activeReplica.entries() },
  { writes: [null], pendingSignIn: undefined, owed: 'A', cleared: [], replica, state: 'anon', entries });
  await engine.cleanupCredentials();
  assert.deepEqual({ cleared, owed: engine.device.meta.clearCredential }, { cleared: ['A'], owed: undefined });
  env.transport.account = 'A';
  assert.equal((await engine.signIn('A')).complete, true);
  const bound = structuredClone(engine.device.meta);
  await assert.rejects(engine.cancelSignIn('A'), /no sign-in is pending/);
  assert.deepEqual({ meta: engine.device.meta, state: engine.device.activeReplica.meta.state }, { meta: bound, state: 'bound' });
  engine.close();
});

test('a sign-in supersedes a credential deletion owed for an earlier session: the credential the browser holds is the one signing in', async () => {
  const env = environment();
  env.options.credentials = { clear: async () => { throw new Error('network unavailable'); } };
  const engine = await open(env);
  assert.equal((await engine.signIn('A')).complete, false);
  await engine.cancelSignIn('A');
  await engine.cleanupCredentials();
  assert.equal(engine.device.meta.clearCredential, 'A');
  env.transport.account = 'A';
  assert.equal((await engine.signIn('A')).complete, true);
  assert.deepEqual({ owed: engine.device.meta.clearCredential, pendingSignIn: engine.device.meta.pendingSignIn, account: engine.device.activeReplica.meta.account },
    { owed: undefined, pendingSignIn: undefined, account: 'A' });
  engine.close();
});

test('the session owner\'s records ride the engine\'s calls: a device cleanup clears only the marker it finished, and an account closure is recorded only for the account bound', async () => {
  const env = environment();
  const engine = await open(env);
  env.transport.account = 'A';
  await engine.signIn('A');
  await assert.rejects(engine.recordAccountClosure('B', 'session-1'), /account changed during closure/);
  await engine.recordAccountClosure('A', 'session-1');
  assert.deepEqual(engine.device.meta.closingAccount, { account: 'A', sessionId: 'session-1' });
  await engine.clearAccountClosure('session-0');
  assert.deepEqual(engine.device.meta.closingAccount, { account: 'A', sessionId: 'session-1' });
  await engine.clearAccountClosure('session-1');
  assert.equal(engine.device.meta.closingAccount, undefined);
  await engine.finishSignOut({ choice: 'keep', deviceCleanup: true });
  const owed = structuredClone(engine.device.meta.deviceCleanup);
  await engine.clearDeviceCleanup({ ...owed, generation: owed.generation - 1 });
  assert.deepEqual(engine.device.meta.deviceCleanup, owed);
  await engine.clearDeviceCleanup(owed);
  assert.deepEqual({ previous: owed.previous, left: engine.device.meta.deviceCleanup }, { previous: 'A', left: undefined });
  engine.close();
});

test('a bound replica pauses once the session owner finds the browser holds another credential, or none; an unknown answer changes nothing', async () => {
  const env = environment();
  const engine = await open(env);
  env.transport.account = 'A';
  await engine.signIn('A');
  await engine.credentialHeld(undefined);
  await engine.credentialHeld('A');
  assert.equal(engine.device.activeReplica.meta.authPaused, false);
  await engine.credentialHeld(null);
  assert.deepEqual({ authPaused: engine.device.activeReplica.meta.authPaused, canSync: engine.canSync(),
    paused: env.events.filter(({ name }) => name === 'sync-auth-paused').map(({ props }) => props.outcome) },
  { authPaused: true, canSync: false, paused: ['paused'] });
  engine.close();
});

test('the store remembers the replica ids it lets go, one a re-identify replaced and a discarded replica\'s, through a reload', async () => {
  const env = environment();
  let engine = await open(env);
  const anon = engine.activeReplica();
  env.transport.account = 'A';
  await engine.signIn('A');
  const bound = engine.activeReplica();
  await engine.write(null, (device, ctx) => reidentify(device.activeReplica, ctx));
  const reidentified = engine.activeReplica();
  assert.equal((await engine.finishSignOut({ choice: 'discard', counted: [] })).complete, true);
  engine.close();
  engine = await BrowserSyncEngine.open(env.options);
  assert.deepEqual({ replicas: engine.device.replicas.map(({ id }) => id), former: engine.device.meta.formerReplicas },
    { replicas: [anon], former: [bound, reidentified] });
  engine.close();
});

test('a store the browser cleared is told once, by one of two tabs, and a reload and the next read find its mark', async () => {
  const env = environment();
  const cleared = () => env.events.filter(({ name }) => name === 'sync-store-cleared');
  let a = await open(env);
  env.transport.account = 'A';
  await a.signIn('A'); await until(() => a.leader);
  await a.commit('self/probe', card());
  await a.send();
  const pushedFor = a.activeReplica();
  a.close();
  await new Promise((resolve, reject) => Object.assign(env.indexedDB.deleteDatabase('wm-sync'), { onsuccess: resolve, onerror: reject }));
  a = await open(env);
  const b = await peer(env);
  await a.signIn('A');
  await until(() => b.activeReplica() === a.activeReplica());
  assert.deepEqual({ a: a.getSnapshot().storeCleared, b: b.getSnapshot().storeCleared, told: cleared() }, { a: false, b: false, told: [] });
  await Promise.all([a.sessionReplica('A', pushedFor), b.sessionReplica('A', pushedFor)]);
  await until(() => b.getSnapshot().storeCleared);
  await a.sessionReplica('A', pushedFor);
  assert.deepEqual({ a: a.getSnapshot().storeCleared, told: cleared() }, { a: true, told: [{ name: 'sync-store-cleared', props: {} }] });
  a.close(); b.close();
  a = await open(env);
  await a.sessionReplica('A', pushedFor);
  assert.deepEqual({ storeCleared: a.getSnapshot().storeCleared, told: cleared().length, ids: JSON.stringify(env.events).includes('rp_'), failures: env.failures },
    { storeCleared: true, told: 1, ids: false, failures: [] });
  a.close();
});

test('the store keeps the latest 32 replica ids it let go, in the order it let them go', async () => {
  const env = environment();
  const engine = await open(env);
  env.transport.account = 'A';
  await engine.signIn('A');
  const letGo = [];
  for (let turn = 0; turn < 40; turn++) {
    letGo.push(engine.activeReplica());
    await engine.write(null, (device, ctx) => reidentify(device.activeReplica, ctx));
  }
  assert.deepEqual(engine.device.meta.formerReplicas, letGo.slice(-32));
  engine.close();
});

// The browser cleared the store under a session that had pushed for the account's replica; the store's fresh anon replica
// holds work, so the account's first read finds the seat signed out and the sign-in asks its question.
async function clearedWithSignedOutWork(env) {
  let engine = await open(env);
  env.transport.account = 'A';
  await engine.signIn('A');
  await engine.commit('self/probe', card('card0001'));
  await engine.send();
  const pushedFor = engine.activeReplica();
  engine.close();
  await new Promise((resolve, reject) => Object.assign(env.indexedDB.deleteDatabase('wm-sync'), { onsuccess: resolve, onerror: reject }));
  engine = await open(env);
  env.transport.account = null;
  await engine.commit('self/probe', card('card0002'));
  env.transport.account = 'A';
  return { engine, pushedFor };
}

test('a cleared store read while the sign-in question stands is told as the answer binds the seat, before its first push names a replica the store holds', async () => {
  const env = environment();
  const { engine, pushedFor } = await clearedWithSignedOutWork(env);
  const told = () => env.events.filter(({ name }) => name === 'sync-store-cleared');
  const asked = await engine.signIn('A');
  await engine.sessionReplica('A', pushedFor);
  assert.deepEqual({ complete: asked.complete, state: engine.getSnapshot().state, storeCleared: engine.getSnapshot().storeCleared, told: told() },
    { complete: false, state: 'anon', storeCleared: false, told: [] });
  const [due] = asked.due;
  assert.equal((await engine.signIn('A', { decisions: { [due.product]: 'add' }, counted: { [due.product]: due.counted } })).complete, true);
  assert.deepEqual({ storeCleared: engine.getSnapshot().storeCleared, mark: engine.device.meta.storeCleared, told: told() },
    { storeCleared: true, mark: { account: 'A' }, told: [{ name: 'sync-store-cleared', props: {} }] });
  await until(() => engine.leader);
  await engine.send();
  await engine.sessionReplica('A', engine.activeReplica());
  assert.deepEqual({ storeCleared: engine.getSnapshot().storeCleared, told: told().length, failures: env.failures }, { storeCleared: true, told: 1, failures: [] });
  engine.close();
});

test('the clear mark is its account\'s: a Discard sign-out and another account\'s seat read no clear and tell none, and the account\'s own seat reads it again', async () => {
  const env = environment();
  const { engine, pushedFor } = await clearedWithSignedOutWork(env);
  const [due] = (await engine.signIn('A')).due;
  await engine.signIn('A', { decisions: { [due.product]: 'add' }, counted: { [due.product]: due.counted } });
  await engine.sessionReplica('A', pushedFor);
  const seen = () => ({ account: engine.getSnapshot().account, storeCleared: engine.getSnapshot().storeCleared });
  const seats = [seen()];
  const asked = await engine.finishSignOut({ choice: 'discard', counted: [] });
  assert.equal((await engine.finishSignOut({ choice: 'discard', counted: asked.counted })).complete, true);
  seats.push(seen());
  env.transport.account = 'B';
  await engine.signIn('B');
  await engine.sessionReplica('B', `rp_${'b'.repeat(32)}`);
  seats.push(seen());
  assert.equal((await engine.finishSignOut({ choice: 'keep' })).complete, true);
  env.transport.account = 'A';
  await engine.signIn('A');
  seats.push(seen());
  assert.deepEqual({ seats, mark: engine.device.meta.storeCleared, told: env.events.filter(({ name }) => name === 'sync-store-cleared').length },
    { seats: [{ account: 'A', storeCleared: true }, { account: null, storeCleared: false }, { account: 'B', storeCleared: false },
      { account: 'A', storeCleared: true }], mark: { account: 'A' }, told: 1 });
  engine.close();
});

const unknownReplica = `rp_${'f'.repeat(32)}`;
const noClear = {
  'the id a re-identify replaced, answered before the new one\'s first push': async (env) => {
    const engine = await open(env);
    env.transport.account = 'A'; await engine.signIn('A');
    const old = engine.activeReplica();
    await engine.write(null, (device, ctx) => reidentify(device.activeReplica, ctx));
    return { engine, account: 'A', syncReplica: old };
  },
  'a new sign-in, whose session has pushed for no replica': async (env) => {
    const engine = await open(env);
    env.transport.account = 'A'; await engine.signIn('A');
    return { engine, account: 'A', syncReplica: null };
  },
  'an answer for another account than the one the replica is bound to': async (env) => {
    const engine = await open(env);
    env.transport.account = 'A'; await engine.signIn('A');
    return { engine, account: 'B', syncReplica: unknownReplica };
  },
  'a signed-out replica': async (env) => ({ engine: await open(env), account: 'A', syncReplica: unknownReplica }),
  'the bound replica\'s own id, which its pushes carry': async (env) => {
    const engine = await open(env);
    env.transport.account = 'A'; await engine.signIn('A');
    return { engine, account: 'A', syncReplica: engine.activeReplica() };
  },
};
for (const [name, arrange] of Object.entries(noClear)) test(`no cleared store is told for ${name}`, async () => {
  const env = environment();
  const { engine, account, syncReplica } = await arrange(env);
  await engine.sessionReplica(account, syncReplica);
  assert.deepEqual({ storeCleared: engine.getSnapshot().storeCleared, marked: engine.device.meta.storeCleared,
    told: env.events.filter(({ name }) => name === 'sync-store-cleared'), failures: env.failures },
  { storeCleared: false, marked: undefined, told: [], failures: [] });
  engine.close();
});

test('a gym Coach round sits beside runningTurn, and a build whose registry knows no runningRound still reads and clears runningTurn over it', async () => {
  const directory = new URL('../../../../packages/api-contract/sync/', import.meta.url);
  const read = (name) => JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
  const composition = read('composition.json');
  const registries = Object.fromEntries(composition.registries.map((name) => [name, read(name)]));
  const older = structuredClone(registries);
  delete older['gym.registry.json'].products.gym.device.runningRound;
  const round = { message: 'coach0000000001', callId: 'AAAAAAAAAAAAAAAAAAAAAA', bytesBefore: 17 };
  const env = environment();
  const reopen = async (parts) => {
    env.options.registry = new Registry(composeRegistry(composition, parts));
    const engine = await BrowserSyncEngine.open(env.options);
    await engine.start();
    await until(() => engine.leader);
    return engine;
  };

  const current = await reopen(registries);
  await current.commit('self/gym', [], { local: { runningTurn: 'coach0000000001', runningRound: round } });
  const written = current.readDeviceRows('gym');
  current.close();

  const old = await reopen(older);
  const carried = old.readDeviceRows('gym');
  await assert.rejects(old.commit('self/gym', [], { local: { runningRound: null } }), /device row runningRound matches no row of gym/);
  await old.commit('self/gym', [], { local: { runningTurn: null } });
  old.close();

  const again = await reopen(registries);
  assert.deepEqual({ written, carried, after: again.readDeviceRows('gym') }, {
    written: { runningTurn: 'coach0000000001', runningRound: round },
    carried: { runningTurn: 'coach0000000001', runningRound: round },
    after: { runningRound: round },
  });
  again.close();
});

// Talk's mark (Journal Talk D-5) is the journal's device row talkTake. It rides in the gesture of the save beside it and
// never in a push, and a build whose registry declares no talkTake opens the store, carries the mark untouched and
// cannot write it.
test('Talk\'s mark stays in device/journal: the save beside it pushes without it, and a build that knows no talkTake carries it', async () => {
  const directory = new URL('../../../../packages/api-contract/sync/', import.meta.url);
  const read = (name) => JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
  const composition = read('composition.json');
  const registries = Object.fromEntries(composition.registries.map((name) => [name, read(name)]));
  const older = structuredClone(registries);
  delete older['journal.registry.json'].products.journal.device.talkTake;
  const mark = { day: '2026-11-28', bytesBefore: 120, pageDigest: '9dd9da01856b9b41',
    sessions: [{ callId: 'talkSessionOne-0000001', bytesSaved: 48, heardAt: 1795824000000 }] };
  const env = environment();
  const reopen = async (parts) => {
    env.options.registry = new Registry(composeRegistry(composition, parts));
    const engine = await BrowserSyncEngine.open(env.options);
    await engine.start();
    await until(() => engine.leader);
    return engine;
  };

  const current = await reopen(registries);
  env.transport.response = async (endpoint) => {
    if (endpoint !== 'hello') return { response: { status: 503, body: { retryAfterMs: 5000 } }, timing: {} };
    const ready = readyHello(env);
    ready.response.body.holdsRecords = { gym: false, journal: false, roadmap: false };
    return ready;
  };
  env.transport.account = 'A'; await current.signIn('A'); await until(() => current.leader);
  await current.commit('self/journal', [{ op: 'write', t: 'journalState', id: 'journalState', f: { placeholder: 'retired' } }],
    { local: { talkTake: mark } });
  await current.send();
  const pushes = env.requests.filter(({ endpoint }) => endpoint === 'push').map(({ request }) => request);
  const written = current.readDeviceRows('journal');
  current.close();

  const old = await reopen(older);
  const carried = old.readDeviceRows('journal');
  await assert.rejects(old.commit('self/journal', [], { local: { talkTake: null } }), /device row talkTake matches no row of journal/);
  old.close();

  const again = await reopen(registries);
  assert.deepEqual({
    written, carried, after: again.readDeviceRows('journal'),
    pushed: pushes.map((request) => request.intents.map((intent) => intent.d.map((delta) => [delta.t, Object.keys(delta.f ?? {})]))),
    pushedTheMark: pushes.some((request) => /talkTake|pageDigest|talkSessionOne/.test(jcs(request))),
  }, {
    written: { talkTake: mark }, carried: { talkTake: mark }, after: { talkTake: mark },
    pushed: [[[['journalState', ['placeholder']]]]],
    pushedTheMark: false,
  });
  again.close();
});

test('a product drops one kind of its device rows from every replica in one write, and reads its rows, the anon replica\'s records and whether an account\'s replica stays only through the engine', async () => {
  const env = environment();
  const engine = await open(env);
  const picture = { at: 1 };
  env.transport.account = 'A';
  await engine.signIn('A');
  await engine.commit('self/probe', [], { local: { 'picture:account01': picture, rack: { body: 'account' } } });
  await engine.finishSignOut({ choice: 'keep' });
  await engine.commit('self/probe', card(), { local: { 'picture:anon0001': picture, rack: { body: 'anon' } } });
  const rows = engine.readDeviceRows('probe');
  const read = { rows, frozen: Object.isFrozen(rows), same: engine.readDeviceRows('probe') === rows, other: engine.readDeviceRows('gym'),
    anonymous: engine.anonymousRecords(), keepsA: engine.hasReplicaOf('A'), keepsB: engine.hasReplicaOf('B') };
  const writes = [];
  const write = engine.write.bind(engine);
  engine.write = (...args) => { writes.push(args[0]); return write(...args); };
  await engine.dropDeviceRows('probe', 'picture');
  await assert.rejects(engine.dropDeviceRows('probe', 'landing'), /probe declares no device row landing/);
  const replicas = (await engine.store.read()).device.replicas.map((replica) => [replica.meta.state, replica.device.probe]);
  assert.deepEqual({ ...read, writes, replicas }, {
    rows: { 'picture:anon0001': picture, rack: { body: 'anon' } }, frozen: true, same: true, other: {},
    anonymous: { scopes: ['self/probe'], records: [{ scope: 'self/probe', t: 'card', id: 'card0001' }] }, keepsA: true, keepsB: false,
    writes: [null],
    replicas: [['anon', { rack: { body: 'anon' } }], ['dormant', { rack: { body: 'account' } }]],
  });
  engine.close();
});

test('finished offline sign-out durably owes cookie cleanup; restart retries a failed cleanup', async () => {
  const env = environment();
  let calls = 0;
  env.options.credentials = { clear: async () => { calls++; throw new Error('network unavailable'); } };
  let engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A');
  engine.setOnline(false);
  await engine.commit('self/probe', card());
  const question = await engine.beginSignOut();
  assert.equal(question.unsent, 1);
  await engine.finishSignOut({ choice: 'keep', counted: question.counted });
  assert.equal(calls, 0);
  assert.equal(engine.device.meta.clearCredential, 'A');
  engine.close();
  env.options.navigator.onLine = true;
  engine = await open(env);
  assert.equal(calls, 1);
  assert.equal(engine.device.meta.clearCredential, 'A');
  assert.equal(engine.device.activeReplica.meta.state, 'anon');
  engine.credentials.clear = async (account) => { assert.equal(account, 'A'); calls++; };
  await engine.cleanupCredentials();
  assert.equal(engine.device.meta.clearCredential, undefined);
  assert.equal(calls, 2);
  engine.close();
});

// A browser's anonymous pull carries no cookie, and its live socket carries whichever cookie the browser holds as it opens,
// which the server serves every frame on that socket as.
function cookieBrowser(env) {
  const request = env.transport.request.bind(env.transport);
  env.transport.request = async (endpoint, body, options = {}) => {
    if (!options.anonymous) return request(endpoint, body, options);
    const held = env.transport.account;
    env.transport.account = null;
    try { return await request(endpoint, body, options); } finally { env.transport.account = held; }
  };
  const openLive = env.transport.openLive.bind(env.transport);
  env.transport.openLive = () => Object.assign(openLive(), { servedAs: env.transport.account });
  env.state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), 'tree:b_00000001': treeScope('A', 'b_00000001') },
    rows: { 'acct:A/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1)], born: st(1), seq: 1 })],
      'tree:b_00000001': [row({ t: 'meta', id: 'meta', f: { visibility: ['public', st(1)] }, seq: 1 })] },
  }));
}

test('a sign-out made offline deletes the credential it owes before the live socket reopens, so the reopened socket serves the anon replica as nobody and it stays unpaused and pulling', async () => {
  const env = environment(), tree = 'tree/b_00000001';
  cookieBrowser(env);
  env.options.credentials = { clear: async (account) => {
    if (env.transport.account === account) env.transport.account = null;
    return env.transport.account === null;
  } };
  const engine = await open(env);
  env.transport.account = 'A';
  assert.equal((await engine.signIn('A')).complete, true);
  engine.setOnline(false);
  assert.equal((await engine.finishSignOut({ choice: 'keep' })).complete, true);
  assert.equal(engine.device.meta.clearCredential, 'A');
  await engine.subscribe(tree);
  const sockets = env.sockets.length;
  engine.setOnline(true);
  for (let i = 0; i < 100 && engine.device.meta.clearCredential !== undefined; i++) await tick();
  await engine.pull();
  engine.follow();
  const socket = env.sockets.at(-1);
  socket.readyState = 1;
  socket.onopen();
  socket.onmessage({ data: JSON.stringify({ op: 'change', scope: tree, as: socket.servedAs }) });
  await until(() => !engine.live.draining);
  const pulls = env.requests.filter(({ endpoint }) => endpoint === 'pull').length;
  await engine.pull();
  assert.deepEqual({ reopened: env.sockets.length > sockets, servedAs: socket.servedAs, owed: engine.device.meta.clearCredential,
    state: engine.device.activeReplica.meta.state, authPaused: engine.device.activeReplica.meta.authPaused, canSync: engine.canSync(),
    pulled: env.requests.filter(({ endpoint }) => endpoint === 'pull').length > pulls },
  { reopened: true, servedAs: null, owed: undefined, state: 'anon', authPaused: false, canSync: true, pulled: true });
  engine.close();
});

test('while a credential\'s deletion is owed and cannot run, the anon replica pulls but opens no live socket, and closes one it held', async () => {
  const env = environment(), tree = 'tree/b_00000001';
  cookieBrowser(env);
  env.options.credentials = { clear: async () => { throw new Error('network unavailable'); } };
  const engine = await open(env);
  await engine.subscribe(tree);
  await engine.pull();
  engine.follow();
  const held = env.sockets.at(-1);
  assert.deepEqual(await engine.signIn('A'), { complete: false, authPaused: true });
  await engine.cancelSignIn('A');
  await engine.cleanupCredentials();
  const sockets = env.sockets.length;
  const pulls = env.requests.filter(({ endpoint }) => endpoint === 'pull').length;
  engine.kickPull([tree]);
  await engine.pull();
  engine.follow();
  assert.deepEqual({ owed: engine.device.meta.clearCredential, held: held.readyState, opened: env.sockets.length - sockets, live: engine.live.running,
    pulled: env.requests.filter(({ endpoint }) => endpoint === 'pull').length > pulls, authPaused: engine.device.activeReplica.meta.authPaused },
  { owed: 'A', held: 3, opened: 0, live: false, pulled: true, authPaused: false });
  engine.close();
});

test('an anon replica a frame paused stays paused on its own, whatever time passes, until the session owner reads that the browser holds no credential; each turn is told once', async () => {
  const env = environment(), tree = 'tree/b_00000001';
  cookieBrowser(env);
  env.options.credentials = { clear: async () => false };
  const engine = await open(env);
  const told = () => env.events.filter(({ name }) => name === 'sync-auth-paused').map(({ props }) => props.outcome);
  try {
    env.transport.account = 'A';
    assert.equal((await engine.signIn('A')).complete, true);
    await engine.subscribe(tree);
    assert.equal((await engine.finishSignOut({ choice: 'keep' })).complete, true);
    const before = told().length;
    await engine.receiveFrame({ op: 'change', scope: tree, as: 'A' });
    await engine.refresh();
    const requests = env.requests.length;
    for (let i = 0; i < 20; i++) { env.timers.advance(15_000); await tick(); }
    const waited = { authPaused: engine.device.activeReplica.meta.authPaused, requests: env.requests.length - requests };
    await engine.credentialHeld(undefined);
    await engine.credentialHeld('A');
    const unknownOrHeld = engine.device.activeReplica.meta.authPaused;
    env.transport.account = null;
    await engine.credentialHeld(null);
    await engine.pull();
    assert.deepEqual({ waited, unknownOrHeld, authPaused: engine.device.activeReplica.meta.authPaused, canSync: engine.canSync(),
      told: told().slice(before), pulled: env.requests.slice(requests).some(({ endpoint }) => endpoint === 'pull') }, {
      waited: { authPaused: true, requests: 0 },
      unknownOrHeld: true,
      authPaused: false, canSync: true,
      told: ['paused', 'released'], pulled: true,
    });
  } finally { engine.close(); }
});

test('changed sign-out work re-pins Discard; Cancel resumes the account', async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); engine.setOnline(false);
  await engine.commit('self/probe', card());
  const question = await engine.beginSignOut();
  await engine.commit('self/probe', card('card0002'));
  const result = await engine.finishSignOut({ choice: 'discard', counted: question.counted });
  assert.equal(result.complete, false);
  assert.equal(result.unsent, 2);
  assert.equal(engine.device.activeReplica.meta.state, 'bound');
  await engine.cancelSignOut();
  assert.equal(engine.signingOut, false);
  engine.close();
});


test('a peer sign-out durably supersedes a delayed hello even after reload', async () => {
  const env = environment(), a = await open(env);
  env.transport.account = 'A'; await a.signIn('A');
  const b = await peer(env);
  let reply;
  const transport = env.transport.request;
  env.transport.request = (endpoint, ...args) => endpoint === 'hello' ? new Promise((resolve) => { reply = resolve; }) : transport.call(env.transport, endpoint, ...args);
  const delayed = a.signIn('A'); await until(() => !!reply);
  b.setOnline(false); const question = await b.beginSignOut();
  await b.finishSignOut({ choice: 'keep', counted: question.counted });
  reply({ response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 1000, schema: 1, minSchema: 1, holdsRecords: { probe: false } } }, timing: {} });
  assert.deepEqual(await delayed, { complete: false, superseded: true });
  await a.refresh(); assert.equal(a.device.activeReplica.meta.state, 'anon');
  a.close(); b.close();
  const reopened = await BrowserSyncEngine.open(env.options);
  assert.equal(reopened.device.activeReplica.meta.state, 'anon'); reopened.close();
});

test('shared sign-out pauses numbering across leadership handoff; Cancel and owner death resume', async () => {
  const env = environment(), leader = await open(env);
  env.transport.account = 'A'; await leader.signIn('A'); await until(() => leader.leader);
  const owner = await peer(env); owner.setOnline(false);
  const question = await owner.beginSignOut();
  await owner.commit('self/probe', card());
  await until(() => leader.signingOut);
  await leader.send();
  assert.equal((await leader.store.read()).device.activeReplica.outbox[0].n, undefined);
  await owner.cancelSignOut(); await until(() => !leader.signingOut);
  await leader.send(); assert.equal(leader.device.activeReplica.outbox[0].state, 'acked');
  await owner.beginSignOut(); leader.close(); await until(() => owner.leader);
  const survivor = await peer(env); owner.close(); await until(() => survivor.leader);
  env.timers.advance(1000); await until(() => !survivor.device.meta.signOut);
  assert.equal(survivor.device.activeReplica.meta.state, 'bound');
  assert.equal(question.complete, false); survivor.close();
});

test('follower bounded flush runs via leader; stalled request is abandoned at the shared deadline', async () => {
  const env = environment(), leader = await open(env);
  env.transport.account = 'A'; await leader.signIn('A'); await until(() => leader.leader);
  const owner = await peer(env);
  await owner.commit('self/probe', card());
  let request;
  env.transport.response = (endpoint) => endpoint === 'hello' ? Promise.resolve(readyHello(env)) : endpoint === 'push' ? new Promise((resolve) => { request = resolve; }) : Promise.resolve({ response: { status: 503 }, timing: {} });
  const decision = owner.beginSignOut();
  await until(() => leader.device.meta.signOut?.phase === 'flush');
  env.timers.advance(0); await until(() => !!request);
  env.timers.advance(owner.limits.SIGNOUT_FLUSH_MS);
  const question = await decision;
  assert.equal(question.unsent, 1);
  assert.equal((await owner.store.read()).device.meta.signOut.phase, 'decision');
  await owner.finishSignOut({ choice: 'keep', counted: question.counted });
  request({ response: { status: 200, body: { as: 'A', epoch: 'ep-1', serverTime: 6000, lastN: 1, results: [{ n: 1, s: 'ok', seq: 1 }] } }, timing: {} });
  await until(() => !leader.sending);
  assert.equal((await owner.store.read()).device.activeReplica.meta.state, 'anon');
  leader.close(); owner.close();
});

test('idle leader reconciles a committed outbox without a channel hint and honors durable retry floors', async () => {
  const env = environment(), leader = await open(env);
  env.transport.account = 'A'; await leader.signIn('A'); await until(() => leader.leader);
  await leader.send();
  const writer = await peer(env); writer.coordination.post = () => {};
  await writer.commit('self/probe', card()); writer.close();
  env.timers.advance(1000); await until(() => leader.device.activeReplica.outbox.length === 1);
  env.transport.response = async (endpoint) => endpoint === 'hello' ? readyHello(env) : ({ response: { status: 503, body: { retryAfterMs: 5000 } }, timing: {} });
  env.timers.advance(0); await until(() => !leader.sending && leader.device.activeReplica.meta.pushRetryAt === 7000);
  const pushes = env.requests.filter(({ endpoint }) => endpoint === 'push').length;
  env.timers.advance(1000); await tick(); await tick();
  env.timers.advance(0); await tick();
  assert.equal(env.requests.filter(({ endpoint }) => endpoint === 'push').length, pushes);
  const successor = await peer(env); leader.close(); await until(() => successor.leader);
  env.timers.advance(0); await tick();
  assert.equal(env.requests.filter(({ endpoint }) => endpoint === 'push').length, pushes);
  env.timers.advance(4000); await until(() => env.requests.filter(({ endpoint }) => endpoint === 'push').length > pushes);
  successor.close();
});

test('durable commit returns its IDs when publication fails, and an offline reopen recovers it', async () => {
  const env = environment(), engine = await open(env);
  const read = engine.store.read;
  engine.store.read = () => Promise.reject(new Error('versionchange'));
  const result = await engine.commit('self/probe', card(), { hold: true });
  assert.equal(result.localIds.length, 1);
  engine.store.read = read; engine.close();
  const reopened = await BrowserSyncEngine.open(env.options);
  assert.equal(reopened.device.activeReplica.entry(result.localIds[0]).state, 'held');
  assert.equal(reopened.observe('self/probe').getSnapshot().drawn[0].f.title[0], 'secret');
  assert.ok(env.failures.includes('storage')); reopened.close();
});

test('closing during publication retains the committed work without reporting the closed store as a failure', async () => {
  const env = environment(), engine = await open(env);
  const read = engine.store.read.bind(engine.store);
  let finish;
  engine.store.read = async (...args) => {
    await read(...args);
    return new Promise((_resolve, reject) => { finish = reject; });
  };
  const committing = engine.commit('self/probe', card(), { hold: true });
  await until(() => !!finish);
  engine.close();
  finish(new DOMException('connection closed', 'InvalidStateError'));
  const result = await committing;
  assert.deepEqual(env.failures, []);
  env.options.navigator.onLine = false;
  const reopened = await BrowserSyncEngine.open(env.options);
  assert.equal(reopened.device.activeReplica.entry(result.localIds[0]).state, 'held');
  assert.equal(reopened.observe('self/probe').getSnapshot().drawn[0].f.title[0], 'secret');
  reopened.close();
});

test('426 is durable without channel delivery; all requests including hello stop until build changes', async () => {
  const env = environment(), a = await open(env), b = await peer(env);
  a.coordination.post = () => {};
  env.transport.response = async () => ({ response: { status: 426 }, timing: {} });
  await a.signIn('A'); const count = env.requests.length;
  assert.deepEqual(await b.signIn('A'), { complete: false, upgradeRequired: true });
  assert.equal(env.requests.length, count);
  a.close(); b.close();
  const reopened = await BrowserSyncEngine.open(env.options);
  assert.equal(reopened.upgradeRequired, true);
  await reopened.signIn('A'); assert.equal(env.requests.length, count); reopened.close();
  const upgraded = await BrowserSyncEngine.open({ ...env.options, appVersion: '2' });
  assert.equal(upgraded.upgradeRequired, false);
  await upgraded.signIn('A'); assert.equal(env.requests.length, count + 1); upgraded.close();
});

test('sign-out owner death resumes pulls when the outbox is empty; overlapping begins hold one owner lock', async () => {
  const env = environment(), leader = await open(env);
  env.transport.account = 'A'; await leader.signIn('A'); await until(() => leader.leader);
  const owner = await peer(env); owner.setOnline(false);
  const begin = owner.beginSignOut();
  await assert.rejects(owner.beginSignOut(), /already in progress/);
  await begin;
  assert.equal((await env.locks.query()).held.filter(({ name }) => name.startsWith('wm-signout:')).length, 1);
  await until(() => leader.signingOut);
  const pulls = env.requests.filter(({ endpoint }) => endpoint === 'pull').length;
  owner.close(); env.timers.advance(1000); await until(() => !leader.device.meta.signOut);
  env.timers.advance(0); await until(() => env.requests.filter(({ endpoint }) => endpoint === 'pull').length > pulls);
  assert.equal((await env.locks.query()).held.filter(({ name }) => name.startsWith('wm-signout:')).length, 0);
  leader.close();
});

for (const endpoint of ['push', 'pull']) test(`a ${endpoint} paused on its writer cannot start networking after going offline`, async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  await engine.commit('self/probe', card());
  const count = env.requests.filter((request) => request.endpoint === endpoint).length;
  const write = engine.write.bind(engine);
  let release, paused = false, writes = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  engine.write = async (...args) => {
    const result = await write(...args);
    if (++writes === (endpoint === 'push' ? 2 : 1)) { paused = true; await gate; }
    return result;
  };
  const attempt = endpoint === 'push' ? engine.send() : engine.pull();
  await until(() => paused);
  engine.setOnline(false);
  release();
  await attempt;
  assert.equal(env.requests.filter((request) => request.endpoint === endpoint).length, count);
  assert.deepEqual(env.failures, []);
  if (endpoint === 'push') assert.deepEqual(engine.device.activeReplica.entries().map(({ state }) => state), ['sent']);
  engine.close();
});

for (const stop of ['close', 'handoff']) test(`a request stalled on storage does not start networking after ${stop}`, async () => {
  const env = environment(), engine = await open(env);
  const snapshot = await engine.store.read([]);
  let releaseRead;
  engine.store.read = () => new Promise((resolve) => { releaseRead = () => resolve(snapshot); });
  const request = engine.request('push', {});
  await until(() => !!releaseRead);
  if (stop === 'close') engine.close();
  else engine.coordination.release();
  releaseRead();
  await assert.rejects(request, { name: 'AbortError' });
  assert.deepEqual(env.requests, []);
  engine.close();
});

for (const stop of ['response', 'page']) test(`a pull whose ${stop} lands as the engine closes stores nothing and reports no storage failure`, async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  await engine.commit('self/probe', card());
  await engine.send();
  const request = env.transport.request.bind(env.transport), storePages = engine.storePages.bind(engine);
  if (stop === 'response') env.transport.request = async (...args) => { const answer = await request(...args); engine.close(); return answer; };
  else engine.storePages = async (...args) => { engine.close(); return storePages(...args); };
  await engine.pull();
  await assert.rejects(engine.write(null, () => {}), (error) => error instanceof CommitError && error.kind === 'store');
  assert.deepEqual(env.failures, []);
  env.options.navigator.onLine = false;
  const reopened = await BrowserSyncEngine.open(env.options);
  assert.equal(reopened.device.activeReplica.cursorOf('self/probe').cursor, null);
  assert.deepEqual(reopened.device.activeReplica.entries().map(({ state }) => state), ['acked']);
  reopened.close();
});

test('stale sign-out cannot finish against another account after a missed invalidation', async () => {
  const env = environment(), stale = await open(env);
  env.transport.account = 'A'; await stale.signIn('A'); await until(() => stale.leader);
  const peerEngine = await peer(env);
  const oldView = stale.device;
  stale.coordination.channel.onmessage = null;
  peerEngine.coordination.post = () => {};
  await peerEngine.finishSignOut({ choice: 'keep' });
  env.transport.account = 'B'; await peerEngine.signIn('B');
  stale.device = oldView;
  assert.equal(stale.device.activeReplica.meta.account, 'A');
  await assert.rejects(stale.finishSignOut({ choice: 'keep' }), /account changed during sign-out/);
  const { device } = await peerEngine.store.read();
  assert.deepEqual({ account: device.activeReplica.meta.account, owed: device.meta.clearCredential }, { account: 'B', owed: undefined });
  stale.close(); peerEngine.close();
});

test('a bound reader opening a foreign tree follows its own overlay and schedules both first pulls', async () => {
  const env = environment(), engine = await open(env);
  try {
    env.transport.account = 'B';
    await engine.signIn('B');
    await until(() => engine.leader);
    await engine.subscribe('tree/b_00000001');
    assert.deepEqual(engine.scopes(), ['self/probe', 'tree/b_00000001', 'self/overlay/b_00000001']);
    assert.equal(engine.pullDirty.has('self/overlay/b_00000001'), true);
    assert.equal(engine.readMetadata('self/overlay/b_00000001').firstPullComplete, false);
  } finally { engine.close(); }
});

test('pages that share a chunk see a board the same answer killed: its tree page applies nothing', async () => {
  const env = environment(), tree = 'tree/b_00000001';
  const board = (life, seq) => row({ t: 'board', id: 'b_00000001', life, born: st(1), seq });
  const oak = row({ t: 'tag', id: 'oak', life: ['alive', st(1)], born: st(1), f: { label: ['Oak', st(1)] }, seq: 1 });
  env.state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), 'tree:b_00000001': treeScope('A', 'b_00000001') },
    rows: { 'acct:A/probe': [board(['alive', st(1)], 1)], 'tree:b_00000001': [oak] },
  }));
  const engine = await open(env);
  try {
    env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
    for (let round = 0; round < 3; round++) { engine.kickPull(); await engine.pull(); }
    assert.deepEqual(engine.device.activeReplica.confirmedRows(tree).map(({ id }) => id), ['oak']);
    const replica = engine.device.activeReplica;
    const live = (seq) => Cursor.encode({ e: 'ep-1', m: 'live', s: seq });
    const dead = board(['dead', st(2)], 2), ash = row({ t: 'tag', id: 'ash', life: ['alive', st(2)], born: st(2), seq: 2 });
    const outcomes = await engine.storePages(replica.storageHandle, [
      { cursor: replica.cursorOf('self/probe').cursor, page: { scope: 'self/probe', kind: 'rows', rows: [dead], more: false, seq: 2, cursor: live(2), digest: scopeDigest([]) } },
      { cursor: replica.cursorOf(tree).cursor, page: { scope: tree, kind: 'rows', rows: [ash], more: false, seq: 2, cursor: live(2), digest: scopeDigest([oak, ash]) } },
    ]);
    assert.deepEqual(outcomes, ['applied', 'outside']);
    assert.equal(engine.lastWrite.rowWrites, 1);
    assert.deepEqual(engine.device.activeReplica.known, { [tree]: 'gone', 'self/overlay/b_00000001': 'gone' });
    assert.deepEqual(engine.device.activeReplica.confirmedRows(tree).map(({ id }) => id), ['oak']);
  } finally { engine.close(); }
});

for (const denial of ['page', 'frame']) test(`a reader overlay survives ack and pull, leaves with the last tab, and clears on a ${denial} denial`, async () => {
  const env = environment(), tree = 'tree/b_00000001', overlay = 'self/overlay/b_00000001';
  const ownerMark = row({ t: 'mark', id: 'oak', f: { done: [true, st(1)] }, seq: 1 });
  env.state = new ServerState(serverState({ scopes: {
    'acct:A/probe': productScope('A'), 'acct:B/probe': productScope('B'),
    'tree:b_00000001': treeScope('A', 'b_00000001'),
    'acct:A/overlay/b_00000001': overlayScope('A', 'b_00000001'),
  }, rows: {
    'acct:A/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1)], born: st(1), seq: 1 })],
    'tree:b_00000001': [row({ t: 'meta', id: 'meta', f: { visibility: ['public', st(1)] }, seq: 1 }),
      row({ t: 'tag', id: 'oak', life: ['alive', st(1)], born: st(1), f: { label: ['Oak', st(1)] }, seq: 2 })],
    'acct:A/overlay/b_00000001': [ownerMark],
  } }));
  const engine = await open(env);
  let other;
  try {
    env.transport.account = 'B'; await engine.signIn('B'); await until(() => engine.leader);
    await engine.subscribe(tree); await engine.pull();
    const view = engine.observe(overlay);
    assert.deepEqual(view.getSnapshot().drawn, []);
    assert.equal(engine.readMetadata(overlay).firstPullComplete, true);
    await engine.commit(overlay, [{ op: 'write', t: 'mark', id: 'oak', f: { done: false } }]);
    await engine.send(); await until(() => !engine.sending);
    assert.deepEqual(engine.device.activeReplica.entries().map(({ state }) => state), ['acked']);
    const ownMark = view.getSnapshot().drawn.map((record) => ({ ...record, seq: 1, rc: env.timers.time, ru: env.timers.time }));
    engine.kickPull(); await engine.pull();
    assert.deepEqual(engine.device.activeReplica.entries(), []);
    assert.deepEqual(view.getSnapshot().drawn, ownMark);
    assert.deepEqual(env.state.toJSON().rows['acct:A/overlay/b_00000001'], [ownerMark]);
    other = await peer(env); await other.subscribe(tree);
    await until(() => [...engine.peerScopes.values()].some((scopes) => scopes.has(tree)));
    await engine.unsubscribe(tree);
    assert.deepEqual(engine.scopes(), ['self/probe', tree, overlay]);
    assert.deepEqual(view.getSnapshot().drawn, ownMark);
    await until(() => [...other.peerScopes.values()].every((scopes) => !scopes.has(tree)));
    if (denial === 'page') await other.unsubscribe(tree);
    else {
      engine.setOnline(false);
      other.close(); other = null;
    }
    await until(() => engine.scopes().length === 1);
    await engine.refresh();
    assert.deepEqual(view.getSnapshot().drawn, []);
    other?.close(); other = null;
    engine.setOnline(true);
    await engine.subscribe(tree); await engine.pull();
    assert.deepEqual(view.getSnapshot().drawn, ownMark);
    if (denial === 'frame') await engine.receiveFrame({ op: 'not-found', scope: tree, as: 'B' });
    else await engine.storePages(engine.device.activeReplica.storageHandle, [{ cursor: engine.device.activeReplica.cursorOf(tree).cursor, page: { scope: tree, kind: 'not-found' } }]);
    assert.deepEqual(engine.device.activeReplica.known, { [tree]: 'not-found', [overlay]: 'not-found' });
    assert.deepEqual(engine.scopes(), ['self/probe']);
    assert.deepEqual(view.getSnapshot().drawn, []);
    await engine.subscribe(tree);
    assert.deepEqual(engine.device.activeReplica.known, {});
    assert.deepEqual(engine.scopes(), ['self/probe', tree, overlay]);
    assert.equal(engine.readMetadata(overlay).firstPullComplete, false);
    await engine.pull();
    assert.deepEqual(view.getSnapshot().drawn, ownMark);
    assert.deepEqual(env.failures, []);
  } finally { other?.close(); engine.close(); }
});

test('an open anonymous tree resolves its overlay separately for each bound account', async () => {
  const env = environment(), engine = await open(env);
  const tree = 'tree/b_00000001', overlay = 'self/overlay/b_00000001';
  try {
    await engine.subscribe(tree);
    assert.deepEqual(engine.scopes(), [tree]);
    await assert.rejects(engine.subscribe(overlay), /tree/);
    env.transport.account = 'B'; await engine.signIn('B');
    assert.deepEqual(engine.scopes(), ['self/probe', tree, overlay]);
    engine.setOnline(false);
    await engine.beginSignOut(); await engine.finishSignOut({ choice: 'keep' });
    assert.deepEqual(engine.scopes(), [tree]);
    assert.deepEqual(engine.observe(overlay).getSnapshot().drawn, []);
    env.transport.account = 'A'; engine.setOnline(true); await engine.signIn('A');
    assert.deepEqual(engine.scopes(), ['self/probe', tree, overlay]);
    assert.deepEqual(engine.observe(overlay).getSnapshot().drawn, []);
  } finally { engine.close(); }
});

test('a tree unsubscribed before its subscribe resolves stays closed, neither pulled nor followed, and opens with the next subscribe', async () => {
  const env = environment(), tree = 'tree/b_00000001';
  env.state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), 'tree:b_00000001': treeScope('A', 'b_00000001') },
    rows: { 'acct:A/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1)], born: st(1), seq: 1 })],
      'tree:b_00000001': [row({ t: 'meta', id: 'meta', f: { visibility: ['public', st(1)] }, seq: 1 })] },
  }));
  const engine = await open(env);
  const pulled = () => env.requests.filter(({ endpoint, request }) => endpoint === 'pull' && request.scopes.some(({ scope }) => scope === tree)).length;
  const reading = () => ({ open: engine.openScopes.has(tree), scopes: engine.scopes(), pulled: pulled(), sockets: env.sockets.length });
  try {
    await Promise.all([engine.subscribe(tree), engine.unsubscribe(tree)]);
    await engine.pull();
    const closed = reading();
    await engine.subscribe(tree);
    await engine.pull();
    assert.deepEqual({ closed, reopened: reading() },
      { closed: { open: false, scopes: [], pulled: 0, sockets: 0 }, reopened: { open: true, scopes: [tree], pulled: 1, sockets: 1 } });
  } finally { engine.close(); }
});

test('a tree two products hold open stays pulled until the last of them lets it go, and an unsubscribe before its subscribe resolves closes that holder alone', async () => {
  const env = environment(), tree = 'tree/b_00000001';
  env.state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), 'tree:b_00000001': treeScope('A', 'b_00000001') },
    rows: { 'acct:A/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1)], born: st(1), seq: 1 })],
      'tree:b_00000001': [row({ t: 'meta', id: 'meta', f: { visibility: ['public', st(1)] }, seq: 1 })] },
  }));
  const engine = await open(env);
  const reading = () => ({ open: engine.openScopes.has(tree), scopes: engine.scopes() });
  try {
    await Promise.all([engine.subscribe(tree), engine.subscribe(tree)]);
    await engine.unsubscribe(tree);
    const afterFirst = reading();
    await Promise.all([engine.subscribe(tree), engine.unsubscribe(tree)]);
    const afterRaced = reading();
    await engine.unsubscribe(tree);
    const afterLast = reading();
    await engine.unsubscribe(tree);
    const afterUnpaired = reading();
    await engine.subscribe(tree);
    assert.deepEqual({ afterFirst, afterRaced, afterLast, afterUnpaired, reopened: reading() }, {
      afterFirst: { open: true, scopes: [tree] }, afterRaced: { open: true, scopes: [tree] }, afterLast: { open: false, scopes: [] },
      afterUnpaired: { open: false, scopes: [] }, reopened: { open: true, scopes: [tree] },
    });
  } finally { engine.close(); }
});

test('an anon replica whose last tree is unsubscribed has nothing to pull, and its puller run still ends following it on the live socket', async () => {
  const env = environment(), tree = 'tree/b_00000001';
  env.state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), 'tree:b_00000001': treeScope('A', 'b_00000001') },
    rows: { 'acct:A/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1)], born: st(1), seq: 1 })],
      'tree:b_00000001': [row({ t: 'meta', id: 'meta', f: { visibility: ['public', st(1)] }, seq: 1 })] },
  }));
  const engine = await open(env);
  try {
    await engine.subscribe(tree);
    await engine.pull();
    const socket = env.sockets.at(-1);
    socket.readyState = 1;
    socket.onopen();
    const followed = [...engine.live.following];
    const pulls = env.requests.filter(({ endpoint }) => endpoint === 'pull').length;
    await engine.unsubscribe(tree);
    env.timers.advance(0);
    await until(() => socket.readyState === 3);
    assert.deepEqual({ followed, following: [...engine.live.following], sent: socket.sent, running: engine.live.running,
      pulls: env.requests.filter(({ endpoint }) => endpoint === 'pull').length - pulls },
    { followed: [tree], following: [], sent: [{ op: 'sub', scopes: [tree] }, { op: 'unsub', scopes: [tree] }], running: false, pulls: 0 });
  } finally { engine.close(); }
});

test('a public tree read signed out goes from the device at a sign-in that leaves the anon replica behind a new one: none of its rows stays at rest', async () => {
  const env = environment(), tree = 'tree/b_00000001';
  env.state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), 'tree:b_00000001': treeScope('A', 'b_00000001') },
    rows: { 'acct:A/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1)], born: st(1), seq: 1 })],
      'tree:b_00000001': [row({ t: 'meta', id: 'meta', f: { visibility: ['public', st(1)] }, seq: 1 })] },
  }));
  const engine = await open(env);
  const atRest = () => new Promise((resolve, reject) => {
    const request = engine.store.database.transaction('rows').objectStore('rows').getAll();
    request.onsuccess = () => resolve(request.result.map(({ value }) => value.t).sort());
    request.onerror = () => reject(request.error);
  });
  try {
    await engine.subscribe(tree);
    await engine.pull();
    const anon = engine.activeReplica();
    const read = { scopes: Object.keys(engine.device.activeReplica.confirmed), rows: await atRest() };
    env.transport.account = 'B';
    assert.equal((await engine.signIn('B')).complete, true);
    await engine.unsubscribe(tree);
    env.timers.advance(0);
    await until(() => engine.store.garbage.size === 0);
    const stored = (await engine.store.read()).device.replicas.map((replica) => ({ anon: replica.id === anon, state: replica.meta.state,
      scopes: Object.keys(replica.confirmed), cursors: Object.keys(replica.cursors), known: replica.known }));
    assert.deepEqual({ read, stored, rows: await atRest() }, {
      read: { scopes: [tree], rows: ['meta'] },
      stored: [{ anon: true, state: 'anon', scopes: [], cursors: [], known: {} }, { anon: false, state: 'bound', scopes: [], cursors: [], known: {} }],
      rows: [],
    });
  } finally { engine.close(); }
});

test('an anon replica forgets the not-found of a tree it may not read once no product holds it open, and keeps one an entry still writes', async () => {
  const env = environment(), denied = 'tree/b_00000001', written = 'tree/b_00000002';
  env.state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), 'tree:b_00000001': treeScope('A', 'b_00000001'), 'tree:b_00000002': treeScope('A', 'b_00000002') },
    rows: { 'acct:A/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1)], born: st(1), seq: 1 }),
      row({ t: 'board', id: 'b_00000002', life: ['alive', st(1)], born: st(1), seq: 2 })] },
  }));
  const engine = await open(env);
  const stored = async () => (await engine.store.read()).device.activeReplica.known;
  try {
    await engine.subscribe(denied);
    await engine.subscribe(written);
    await engine.commit(written, [{ op: 'create', t: 'tag', id: 'oak', f: { label: 'Oak' } }]);
    await engine.pull();
    const open = await stored();
    await engine.pull();
    const pulledAgain = await stored();
    await engine.unsubscribe(denied);
    await engine.unsubscribe(written);
    await engine.pull();
    assert.deepEqual({ open, pulledAgain, closed: await stored(), entries: engine.device.activeReplica.entries().map(({ scope }) => scope) }, {
      open: { [denied]: 'not-found', [written]: 'not-found' },
      pulledAgain: { [denied]: 'not-found', [written]: 'not-found' },
      closed: { [written]: 'not-found' },
      entries: [written],
    });
  } finally { engine.close(); }
});

test('a bound replica forgets the not-found of another account\'s tree it may not read once it is closed, and keeps the gone of its own dead tree', async () => {
  const env = environment(), denied = 'tree/b_00000001', dead = 'tree/b_00000003';
  env.state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), 'acct:B/probe': productScope('B'),
      'tree:b_00000001': treeScope('A', 'b_00000001'), 'tree:b_00000003': treeScope('B', 'b_00000003', { state: 'dead' }) },
    rows: { 'acct:A/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1)], born: st(1), seq: 1 })] },
  }));
  const engine = await open(env);
  const stored = async () => (await engine.store.read()).device.activeReplica.known;
  try {
    env.transport.account = 'B';
    assert.equal((await engine.signIn('B')).complete, true);
    await engine.subscribe(denied);
    await engine.subscribe(dead);
    await engine.pull();
    const open = await stored();
    await engine.unsubscribe(denied);
    await engine.unsubscribe(dead);
    await engine.pull();
    assert.deepEqual({ open, closed: await stored(), reopened: await engine.subscribe(dead) }, {
      open: { [denied]: 'not-found', 'self/overlay/b_00000001': 'not-found', [dead]: 'gone', 'self/overlay/b_00000003': 'gone' },
      closed: { [dead]: 'gone', 'self/overlay/b_00000003': 'gone' },
      reopened: 'gone',
    });
  } finally { engine.close(); }
});

test('an opted act journals in IndexedDB, and its Undo survives a reopen, reports its wait and settles through the reference server', async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A';
  assert.equal((await engine.signIn('A')).complete, true);
  await until(() => engine.leader);
  await engine.commit('self/probe', card());
  await engine.send(); await engine.pull();
  const title = { scope: 'self/probe', t: 'card', id: 'card0001', slot: { kind: 'field', name: 'title' } };
  const { outcome: act } = await engine.commitAct([{ scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: 'card0001', f: { title: 'renamed' } }] }],
    { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: title }] }] }] } });
  await engine.send(); await engine.pull();
  assert.equal(engine.device.activeReplica.journal[0].sourceEntries[0].attempts[0].outcome, 'ok');
  env.transport.response = () => new Promise(() => {});
  const requested = await engine.requestInverse(act.gestureId);
  assert.deepEqual([requested.kind, requested.localChanged], ['pending', true]);
  assert.equal(engine.observe('self/probe').getSnapshot().drawn.find((record) => record.t === 'card').f.title[0], 'secret');
  engine.close();
  env.transport.response = null;
  const reopened = await open(env);
  assert.deepEqual(reopened.readInverseResult(requested.requestId), requested);
  await reopened.send(); await reopened.pull();
  assert.deepEqual(reopened.readInverseResult(requested.requestId), { kind: 'settled', requestId: requested.requestId,
    inverseActId: requested.inverseActId, changed: true, appliedCount: 1, skippedCount: 0 });
  assert.equal(reopened.device.activeReplica.confirmedRows('self/probe')[0].f.title[0], 'secret');
  const inverse = env.events.filter(({ name }) => name === 'sync-inverse').map(({ props }) => props);
  assert.equal(inverse.length, 3);
  assert.deepEqual(inverse[0], { outcome: 'pending' });
  assert.deepEqual(Object.keys(inverse[1]).sort(), ['ageMs', 'outcome', 'waiting']);
  assert.deepEqual([inverse[1].outcome, inverse[1].waiting], ['pending', 1]);
  assert.ok(Number.isSafeInteger(inverse[1].ageMs) && inverse[1].ageMs >= 0);
  assert.deepEqual(inverse[2], { outcome: 'settled', applied: 1, skipped: 0 });
  assert.deepEqual(reopened.device.activeReplica.journal, []);
  assert.equal(await reopened.releaseReversibleAct(act.gestureId), false);
  reopened.close();
});

test('a tag deleted on another device keeps its dead row\'s seq in IndexedDB, so the Undo of its revival after a reopen applies', async () => {
  const env = environment(), tree = 'tree/b_00000001', oak = { t: 'tag', id: 'oak', born: st(1) };
  env.state = new ServerState(serverState({
    scopes: { 'acct:A/probe': productScope('A'), 'tree:b_00000001': treeScope('A', 'b_00000001') },
    rows: { 'acct:A/probe': [row({ t: 'board', id: 'b_00000001', life: ['alive', st(1)], born: st(1), seq: 1 })],
      'tree:b_00000001': [row({ ...oak, life: ['alive', st(1)], f: { label: ['Oak', st(1)] }, seq: 1 })] },
  }));
  const serverOak = () => env.state.rows['tree:b_00000001'][JSON.stringify(['tag', 'oak'])];
  const engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  for (let round = 0; round < 3; round++) { engine.kickPull(); await engine.pull(); }
  env.state = push({ state: env.state, registry, product, account: 'A', serverNow: env.timers.time, request: { replica: 'rp_0000000000000000000000000000000b',
    account: 'A', ackThrough: 0, intents: [{ n: 1, scope: tree, d: [{ ...oak, life: ['dead', st(2, 0, OTHER)] }] }] } }).state;
  engine.kickPull(); await engine.pull();
  const deathSeq = serverOak().seq;
  assert.deepEqual(engine.device.activeReplica.confirmedRows(tree), []);
  engine.close();

  const reopened = await open(env);
  const life = { scope: tree, t: 'tag', id: 'oak', slot: { kind: 'life' } };
  const label = { scope: tree, t: 'tag', id: 'oak', slot: { kind: 'field', name: 'label' } };
  const { outcome: act } = await reopened.commitAct([{ scope: tree, changes: [{ op: 'revive', t: 'tag', id: 'oak', f: { label: 'Next' } }] }],
    { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restoreTree',
      targets: [{ target: life, defaultValue: 'dead' }, { target: label, defaultValue: 'Oak' }] }] }] } });
  assert.deepEqual(reopened.device.activeReplica.journal[0].sourceEntries[0].preimages.map(({ rowSeq }) => rowSeq), [deathSeq, deathSeq]);
  await reopened.send(); await reopened.pull();
  assert.deepEqual([serverOak().life[0], serverOak().f.label[0]], ['alive', 'Next']);
  const requested = await reopened.requestInverse(act.gestureId);
  await reopened.send(); await reopened.pull();
  assert.deepEqual(reopened.readInverseResult(requested.requestId), { kind: 'settled', requestId: requested.requestId,
    inverseActId: requested.inverseActId, changed: true, appliedCount: 2, skippedCount: 0 });
  assert.deepEqual([serverOak().life[0], serverOak().f.label[0]], ['dead', 'Oak']);
  assert.deepEqual(reopened.device.activeReplica.confirmedRows(tree), []);
  assert.deepEqual(env.failures, []);
  reopened.close();
});

test('a Redo asked signed out on a fresh browser draws the day and waits for an epoch, and goes up once the first pull gives the replica one', async () => {
  const env = environment(), engine = await open(env);
  const day = { scope: 'self/probe', t: 'day', id: '2026-11-24' };
  const score = { ...day, slot: { kind: 'field', name: 'score' } };
  const { outcome: act } = await engine.commitAct([{ scope: 'self/probe', changes: [{ op: 'put', t: 'day', id: day.id, f: { score: 5 } }], opts: { hold: true } }],
    { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore', targets: [{ target: score, defaultValue: 0 }] }] }] } });
  const cancelled = await engine.requestInverse(act.gestureId);
  const redo = await engine.requestInverse(cancelled.inverseActId);
  assert.deepEqual([cancelled.kind, redo.kind, redo.localChanged], ['cancelled', 'pending', true]);
  env.transport.account = 'A';
  assert.equal((await engine.signIn('A')).complete, true);
  await until(() => engine.leader);
  await engine.send();
  assert.deepEqual([engine.device.activeReplica.meta.serverEpoch, env.requests.filter(({ endpoint }) => endpoint === 'push').length], [null, 0]);
  assert.equal(engine.observe('self/probe').getSnapshot().drawn.find((record) => record.t === 'day').f.score[0], 5);
  engine.kickPull();
  await engine.pull();
  assert.equal(engine.device.activeReplica.meta.serverEpoch, 'ep-1');
  env.timers.advance(0);
  await until(() => engine.readInverseResult(redo.requestId).kind === 'settled');
  assert.deepEqual(engine.readInverseResult(redo.requestId), { kind: 'settled', requestId: redo.requestId,
    inverseActId: redo.inverseActId, changed: true, appliedCount: 1, skippedCount: 0 });
  const stored = env.state.rows['acct:A/probe'][JSON.stringify(['day', day.id])];
  assert.deepEqual([stored.life[0], stored.f.score[0]], ['alive', 5]);
  engine.close();
});

// engine.md §7.4: a sender round with nothing to push asks the server nothing and waits for a kick. Every pull hangs
// until released, as the first pull after sign-in may, while the fake clock runs 20 s in rounds of 100 ms.
const senderRounds = {
  'a Redo waiting for an epoch asks nothing, and goes up once the first pull gives the replica one': {
    signedOut: async (engine) => {
      const day = { scope: 'self/probe', t: 'day', id: '2026-11-24' };
      const { outcome: act } = await engine.commitAct([{ scope: 'self/probe', changes: [{ op: 'put', t: 'day', id: day.id, f: { score: 5 } }], opts: { hold: true } }],
        { undo: { version: 1, segments: [{ index: 0, recipes: [{ kind: 'fields', restoreCommand: 'probe.restore',
          targets: [{ target: { ...day, slot: { kind: 'field', name: 'score' } }, defaultValue: 0 }] }] }] } });
      return engine.requestInverse((await engine.requestInverse(act.gestureId)).inverseActId);
    },
    whilePulling: { hellos: 0, pushes: 0, epoch: null },
    afterPull: { hellos: 1, pushes: 1, epoch: 'ep-1' },
  },
  'an entry held back behind a held put asks nothing during the hold, and both go up once it ends': {
    signedIn: async (engine) => {
      await engine.commit('self/probe', [{ op: 'put', t: 'day', id: '2026-11-24', f: { score: 5 } }], { hold: true });
      await engine.commit('self/probe', [{ op: 'put', t: 'day', id: '2026-11-24', f: { score: 6 } }]);
    },
    whilePulling: { hellos: 1, pushes: 1, epoch: 'ep-1' },
    afterPull: { hellos: 1, pushes: 1, epoch: 'ep-1' },
  },
  'a plain commit goes up once': {
    signedOut: async (engine) => { await engine.commit('self/probe', [{ op: 'put', t: 'day', id: '2026-11-24', f: { score: 5 } }]); },
    whilePulling: { hellos: 1, pushes: 1, epoch: 'ep-1' },
    afterPull: { hellos: 1, pushes: 1, epoch: 'ep-1' },
  },
};
for (const [name, { signedOut, signedIn, whilePulling, afterPull }] of Object.entries(senderRounds)) test(`the sender: ${name}`, async () => {
  const env = environment(), engine = await open(env);
  const redo = await signedOut?.(engine);
  const pulls = [];
  let pullsFlow = false;
  const request = env.transport.request.bind(env.transport);
  env.transport.request = (endpoint, body, options) => (endpoint === 'pull' && !pullsFlow
    ? new Promise((resolve) => pulls.push(() => resolve(request(endpoint, body, options)))) : request(endpoint, body, options));
  env.transport.account = 'A';
  assert.equal((await engine.signIn('A')).complete, true);
  await until(() => engine.leader);
  await signedIn?.(engine);
  const run = async (ms) => {
    for (let at = 0; at < ms; at += 100) {
      env.timers.advance(100);
      for (let k = 0; k < 40; k++) await tick();
    }
  };
  const sent = () => ({ hellos: env.requests.filter(({ endpoint }) => endpoint === 'hello').length - hellosAtSignIn,
    pushes: env.requests.filter(({ endpoint }) => endpoint === 'push').length, epoch: engine.device.activeReplica.meta.serverEpoch });
  const hellosAtSignIn = env.requests.filter(({ endpoint }) => endpoint === 'hello').length;
  await run(20_000);
  assert.deepEqual(sent(), whilePulling);
  pullsFlow = true;
  for (const answer of pulls) answer();
  await run(5_000);
  assert.deepEqual(sent(), afterPull);
  if (redo) assert.deepEqual(engine.readInverseResult(redo.requestId), { kind: 'settled', requestId: redo.requestId,
    inverseActId: redo.inverseActId, changed: true, appliedCount: 1, skippedCount: 0 });
  engine.close();
});
