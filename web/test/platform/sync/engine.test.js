import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { CommitError } from '../../../../packages/api-contract/sync/reference/client/commit.js';
import { releaseDue } from '../../../../packages/api-contract/sync/reference/client/hold.js';
import { reidentify } from '../../../../packages/api-contract/sync/reference/client/lifecycle.js';
import { nextPush } from '../../../../packages/api-contract/sync/reference/client/sender.js';
import { Cursor } from '../../../../packages/api-contract/sync/reference/core/wire.js';
import { scopeDigest } from '../../../../packages/api-contract/sync/reference/core/digest.js';
import { hashText } from '../../../src/platform/sync/core/encoding.js';
import { jcs } from '../../../../packages/api-contract/sync/reference/core/jcs.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { environment, until, tick } from './fakes.js';

const card = (id = 'card0001') => [{ op: 'create', t: 'card', id, f: { title: 'secret' } }];
const open = async (env) => {
  const engine = await BrowserSyncEngine.open(env.options);
  engine.observe('self/probe');
  await engine.start();
  await until(() => engine.leader);
  return engine;
};

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

test('a store that cannot commit is a store failure reported as storage; the read-and-commit function’s own throw is neither', async () => {
  const env = environment(), engine = await BrowserSyncEngine.open(env.options);
  const refusal = new Error('the product refuses this');
  await assert.rejects(engine.commit('self/probe', () => { throw refusal; }), (error) => error === refusal);
  await assert.rejects(engine.commit('self/probe', [{ op: 'nope', t: 'card', id: 'card0002' }]),
    (error) => error instanceof CommitError && error.kind === 'malformed');
  assert.deepEqual(env.failures, []);
  const bug = new TypeError('an engine step broke');
  await assert.rejects(engine.write(null, () => { throw bug; }), (error) => error === bug);
  assert.deepEqual(env.failures, ['storage'], 'the engine’s own broken step still reports');
  const quota = new DOMException('quota', 'QuotaExceededError');
  engine.store.transact = () => Promise.reject(quota);
  await assert.rejects(engine.commit('self/probe', card('card0003')),
    (error) => error instanceof CommitError && error.kind === 'store' && error.cause === quota);
  assert.deepEqual(env.failures, ['storage', 'storage']);
  engine.close();
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
  assert.equal(engine.observe('self/probe'), observation);
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
  assert.deepEqual(env.requests.map(({ endpoint }) => endpoint), ['hello', 'push', 'pull']);
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
  await assert.rejects(engine.storePage(handle, null, page));
  engine = await open(env);
  assert.equal(engine.device.activeReplica.cursorOf('self/probe').cursor, null);
  assert.equal(engine.device.activeReplica.confirmedRows('self/probe').length, 64);
  await engine.storePage(handle, null, page);
  assert.equal(engine.device.activeReplica.confirmedRows('self/probe').length, 130);
  assert.equal(engine.device.activeReplica.cursorOf('self/probe').digest, page.digest);
  assert.equal(engine.device.activeReplica.cursorOf('self/probe').booted, true);
  engine.close();
});

test('server retry floors and clock-skew backoff survive kicks; sender resends ambiguous work', async () => {
  const env = environment(), engine = await open(env);
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  await engine.commit('self/probe', card());
  env.transport.response = async () => ({ response: { status: 503, body: { retryAfterMs: 5000 } }, timing: {} });
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
  env.transport.response = () => ({ response: { status: 409, body: { as: 'A', serverTime: 1000, error: 'gap' } }, timing: {} });
  await engine.send();
  assert.deepEqual(engine.device.toJSON(), before);
  assert.deepEqual((await engine.store.read()).device.toJSON(), before);
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
  assert.deepEqual(env.failures, ['storage']);
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

const peer = async (env) => { const engine = await BrowserSyncEngine.open(env.options); await engine.start(); return engine; };

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
  env.transport.response = (endpoint) => endpoint === 'push' ? new Promise((resolve) => { request = resolve; }) : Promise.resolve({ response: { status: 503 }, timing: {} });
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
  env.transport.response = async () => ({ response: { status: 503, body: { retryAfterMs: 5000 } }, timing: {} });
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
  const count = env.requests.length;
  const write = engine.write.bind(engine);
  let release, paused = false;
  const gate = new Promise((resolve) => { release = resolve; });
  engine.write = async (...args) => {
    const result = await write(...args);
    if (!paused) { paused = true; await gate; }
    return result;
  };
  const attempt = endpoint === 'push' ? engine.send() : engine.pull();
  await until(() => paused);
  engine.setOnline(false);
  release();
  await attempt;
  assert.equal(env.requests.length, count);
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
  assert.equal(device.activeReplica.meta.account, 'B');
  assert.equal(device.meta.clearCredential, 'A');
  stale.close(); peerEngine.close();
});
