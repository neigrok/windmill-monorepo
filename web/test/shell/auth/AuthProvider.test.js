import test from 'node:test';
import { registerNavigationGuard } from '../../../src/shell/navigation.js';
import assert from 'node:assert/strict';
import { elementsOf, loadScreen, renderHook, textOf } from '../../products/gym/harness.mjs';
import { environment, tick, until } from '../../platform/sync/fakes.js';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { syncSession } from '../../../src/platform/sync/session.js';
import { roadmapRoutes } from '../../../src/products/roadmap/routes.js';
import { journalRoutes } from '../../../src/products/journal/routes.js';
import { gymRoutes } from '../../../src/products/gym/routes.js';
import { PRODUCTS } from '../../../src/shell/products.js';
import { ANONYMOUS_OWNER, LAPSED_SESSION, SYNC_STATUS } from '../../../src/products/roadmap/copy.js';

async function account(t) {
  let view;
  t.after(() => view?.unmount());
  const env = environment();
  const storage = new Map();
  const listeners = new Map();
  const broadcasts = [];
  const globals = {
    window: { location: new URL('https://windmill.works/app/roadmap#/app/t_pending'), setTimeout: () => 0,
      history: { state: null, replaceState(state) { this.state = state; } },
      addEventListener: (event, listener) => listeners.set(event, listener),
      removeEventListener: (event) => listeners.delete(event) },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    navigator: env.options.navigator,
    BroadcastChannel: class { constructor() { broadcasts.push(this); } postMessage() {} close() {} },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  window.localStorage = localStorage;
  let engine = await BrowserSyncEngine.open(env.options);
  t.after(() => engine.close());
  env.transport.account = 'A';
  let me = { id: 'A', name: 'Ada' };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: !!me, status: me ? 200 : 401, json: async () => ({ user: me }) }));
  const forgotten = [];
  t.mock.method(roadmapRoutes, 'forgetDevice', (change) => forgotten.push(change));
  let opened;
  t.mock.method(syncSession, 'open', (options) => { opened = options; engine.credentials = options.credentials; return Promise.resolve(engine); });
  t.mock.method(syncSession, 'getSnapshot', () => ({ engine, ready: true, online: true, error: false }));
  const prior = { engine: syncSession.engine, opening: syncSession.opening };
  syncSession.engine = engine;
  syncSession.opening = Promise.resolve(engine);
  t.after(() => Object.assign(syncSession, prior));
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { default: AuthProvider } = await loadScreen('shell/auth/AuthProvider.jsx');
  view = renderHook(t, () => AuthProvider({ children: null }));
  const auth = () => view.tree.props.value;
  await until(() => auth().status === 'signed-in');
  assert.equal(auth().status, 'signed-in');
  await engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'card0001', f: { title: 'pending' } }]);
  const replica = engine.device.activeReplica.id;
  const entries = structuredClone(engine.device.activeReplica.outbox);
  return { env, get engine() { return engine; }, get opened() { return opened; }, auth, get view() { return view; }, forgotten, replica, entries, broadcasts, async reload() {
    view.unmount();
    await engine.close();
    engine = await BrowserSyncEngine.open(env.options);
    syncSession.engine = engine;
    syncSession.opening = Promise.resolve(engine);
    delete window.wmDeviceConfirmation;
    view = renderHook(t, () => AuthProvider({ children: null }));
  }, setMe(value) {
    me = value;
    env.transport.account = value?.id ?? null;
  } };
}

for (const trigger of ['refresh', 'poll']) {
  test(`${trigger}: a 401 retains pending work; the same account resumes its original replica`, async (t) => {
    const state = await account(t);
    const { engine, auth, forgotten, replica, entries } = state;
    state.setMe(null);
    if (trigger === 'refresh') await auth().refresh();
    else {
      t.mock.timers.tick(20000);
      await until(() => auth().status === 'ghost');
    }
    assert.deepEqual({ status: auth().status, account: auth().account, user: auth().user, lapsed: auth().lapsed },
      { status: 'ghost', account: null, user: null, lapsed: true });
    assert.deepEqual({ id: engine.device.activeReplica.id, state: engine.device.activeReplica.meta.state,
      account: engine.device.activeReplica.meta.account, authPaused: engine.device.activeReplica.meta.authPaused,
      outbox: engine.device.activeReplica.outbox }, { id: replica, state: 'bound', account: 'A', authPaused: true, outbox: entries });
    assert.deepEqual(forgotten, []);
    assert.equal(window.location.hash, '#/app/t_pending');
    await auth().refresh();
    assert.deepEqual(forgotten, []);
    state.setMe({ id: 'A', name: 'Ada' });
    const signingIn = auth().signIn({ id: 'A', name: 'Ada' });
    assert.equal(auth().roomChanging, false);
    await signingIn;
    assert.equal(auth().roomChanging, false);
    assert.deepEqual({ status: auth().status, lapsed: auth().lapsed, id: engine.device.activeReplica.id,
      authPaused: engine.device.activeReplica.meta.authPaused, outbox: engine.device.activeReplica.outbox },
    { status: 'signed-in', lapsed: false, id: replica, authPaused: false, outbox: entries });
    assert.deepEqual(forgotten, []);
    assert.deepEqual(state.env.failures, []);
  });
}

test('an account the page starts on with no connection is the cached one until the server answers for it, and a later blip does not unsay the answer', async (t) => {
  const state = await account(t);
  assert.equal(state.auth().confirmed, true);
  const answer = globalThis.fetch;
  let connected = false;
  t.mock.method(globalThis, 'fetch', async (...request) => {
    if (!connected) throw new TypeError('offline');
    return answer(...request);
  });

  await state.reload();
  await until(() => state.auth().status === 'signed-in');
  assert.deepEqual({ status: state.auth().status, account: state.auth().account, confirmed: state.auth().confirmed },
    { status: 'signed-in', account: { id: 'A', name: 'Ada' }, confirmed: false });

  connected = true;
  await state.auth().refresh();
  assert.deepEqual({ status: state.auth().status, confirmed: state.auth().confirmed }, { status: 'signed-in', confirmed: true });

  connected = false;
  await state.auth().refresh();
  assert.deepEqual({ status: state.auth().status, confirmed: state.auth().confirmed }, { status: 'signed-in', confirmed: true });

  connected = true;
  state.setMe(null);
  await state.auth().refresh();
  assert.deepEqual({ status: state.auth().status, account: state.auth().account, confirmed: state.auth().confirmed },
    { status: 'ghost', account: null, confirmed: false });
});

test('each read of the account tells the engine whether the server answered, so a page whose engine sends nothing knows when it is out of reach', async (t) => {
  const state = await account(t);
  state.setMe(null);
  await state.auth().refresh();
  const answer = globalThis.fetch;
  let server = 'down';
  t.mock.method(globalThis, 'fetch', async (...request) => {
    if (server === 'down') throw new TypeError('Failed to fetch');
    if (server === 'failing') return { ok: false, status: 503, json: async () => ({}) };
    return answer(...request);
  });
  const told = [];
  for (const next of ['down', 'up', 'failing', 'up']) {
    server = next;
    await state.auth().refresh();
    told.push([next, state.engine.getSnapshot().connection, state.auth().status]);
  }
  assert.deepEqual(told, [['down', 'unreachable', 'ghost'], ['up', 'online', 'ghost'], ['failing', 'unreachable', 'ghost'], ['up', 'online', 'ghost']]);
  assert.equal(state.env.requests.filter(({ endpoint }) => endpoint !== 'hello').length, 0, 'the paused replica sent nothing of its own');
});

test('a read that binds the seat tells the engine the replica its session last pushed for, and one the store never held is a cleared store, told once', async (t) => {
  const state = await account(t);
  const answer = (syncReplica) => t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200,
    json: async () => ({ user: { id: 'A', name: 'Ada' }, signInMethods: [], syncReplica }) }));
  const told = () => state.env.events.filter(({ name }) => name === 'sync-store-cleared');
  answer(state.engine.activeReplica());
  await state.auth().refresh();
  assert.deepEqual({ storeCleared: state.engine.getSnapshot().storeCleared, told: told() }, { storeCleared: false, told: [] });
  answer(`rp_${'e'.repeat(32)}`);
  await state.auth().refresh();
  await state.auth().refresh();
  assert.deepEqual({ storeCleared: state.engine.getSnapshot().storeCleared, told: told(), status: state.auth().status, failures: state.env.failures },
    { storeCleared: true, told: [{ name: 'sync-store-cleared', props: {} }], status: 'signed-in', failures: [] });
});

test('the seat-change hook runs before a sign-out finishes and before a sign-in binds the device, never at a refresh of the bound account', async (t) => {
  const state = await account(t);
  state.engine.online = false;
  const seen = [];
  t.mock.method(gymRoutes.sync, 'seatWillChange', async (engine) => {
    const replica = engine.device.activeReplica.meta;
    seen.push({ state: replica.state, account: replica.account ?? null, signingOut: Boolean(engine.device.meta.signOut) });
  });
  const forgets = t.mock.method(gymRoutes.sync, 'signOutForgets', () => { seen.push('forgets'); return null; });
  await state.auth().refresh();
  assert.deepEqual(seen, []);
  const finished = state.auth().signOut();
  await until(() => elementsOf(state.view.tree).some((node) => node.props.onDecision && node.props.question));
  assert.deepEqual(seen, [], 'the question comes first');
  await elementsOf(state.view.tree).find((node) => node.props.onDecision).props.onDecision('keep');
  assert.equal(await finished, true);
  await state.auth().signIn({ id: 'A', name: 'Ada' });
  assert.deepEqual({ seen, forgets: forgets.mock.callCount(), status: state.auth().status, replica: state.engine.device.activeReplica.meta.state },
    { seen: [{ state: 'bound', account: 'A', signingOut: true }, 'forgets', { state: 'anon', account: null, signingOut: false }],
      forgets: 1, status: 'signed-in', replica: 'bound' });
});

test('a sign-in the engine resumes as it starts runs the seat-change hook in the shell’s preparation', async (t) => {
  const state = await account(t);
  const seen = [];
  t.mock.method(gymRoutes.sync, 'seatWillChange', async () => { seen.push('seat'); });
  await state.opened.prepare(state.engine);
  assert.deepEqual(seen, []);
  await state.engine.write(null, (device) => { device.meta.pendingSignIn = { account: 'A' }; });
  await state.opened.prepare(state.engine);
  assert.deepEqual(seen, ['seat']);
});

test('a different account after a lapse keeps its own replica and invokes roadmap account cleanup once', async (t) => {
  const state = await account(t);
  state.setMe(null);
  await state.auth().refresh();
  state.setMe({ id: 'B', name: 'Bea' });
  await state.auth().signIn({ id: 'B', name: 'Bea' });
  assert.deepEqual(state.forgotten, [{ previous: 'A', next: 'B' }]);
  assert.deepEqual({ status: state.auth().status, lapsed: state.auth().lapsed,
    account: state.engine.device.activeReplica.meta.account, outbox: state.engine.device.activeReplica.outbox },
  { status: 'signed-in', lapsed: false, account: 'B', outbox: [] });
  const retained = state.engine.device.replicas.find((replica) => replica.id === state.replica);
  assert.equal(retained.meta.state, 'dormant');
  assert.deepEqual(retained.outbox, state.entries);
});

test('a confirmed replacement hides the room synchronously until its product cleanup finishes', async (t) => {
  const state = await account(t);
  state.setMe(null);
  await state.auth().refresh();
  let release;
  const cleanup = new Promise((resolve) => { release = resolve; });
  roadmapRoutes.forgetDevice.mock.mockImplementation(async (change) => {
    state.forgotten.push(change);
    await cleanup;
  });
  const me = { id: 'B', name: 'Bea' };
  state.setMe(me);
  const signingIn = state.auth().signIn(me);
  assert.equal(state.auth().roomChanging, true);
  await until(() => state.forgotten.length === 1);
  assert.deepEqual(state.forgotten, [{ previous: 'A', next: 'B' }]);
  assert.equal(state.auth().roomChanging, true);
  release();
  await signingIn;
  assert.equal(state.auth().account.id, 'B');
  assert.equal(state.auth().roomChanging, false);
});

test('a refreshed replacement hides the room before waiting for engine restoration', async (t) => {
  const state = await account(t);
  let release;
  const restoring = new Promise((resolve) => { release = resolve; });
  const me = { id: 'B', name: 'Bea' };
  state.setMe(me);
  globalThis.fetch.mock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => {
    state.engine.restoring = restoring;
    return { user: me };
  } }));
  const refreshing = state.auth().refresh();
  await until(() => state.auth().roomChanging);
  assert.equal(state.engine.device.activeReplica.meta.account, 'A');
  assert.deepEqual(state.forgotten, []);
  release();
  await refreshing;
  assert.equal(state.auth().account.id, 'B');
  assert.equal(state.auth().roomChanging, false);
});

for (const returning of ['B', 'A']) {
  test(`an older queued account settlement cannot expose the room after ${returning === 'A' ? 'B then A are' : 'B is'} confirmed`, async (t) => {
    const state = await account(t);
    const signIn = state.engine.signIn.bind(state.engine);
    let releaseOlder, olderSettling = false, releaseCleanup;
    const older = new Promise((resolve) => { releaseOlder = resolve; });
    const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
    t.mock.method(state.engine, 'signIn', async (...args) => {
      const result = await signIn(...args);
      if (args[0] === 'A') { olderSettling = true; await older; }
      return result;
    });
    roadmapRoutes.forgetDevice.mock.mockImplementation(async (change) => {
      state.forgotten.push(change);
      await cleanup;
    });
    const priorSignIn = state.auth().signIn({ id: 'A', name: 'Ada' });
    await until(() => olderSettling);
    const me = { id: 'B', name: 'Bea' };
    state.setMe(me);
    const replacement = state.auth().signIn(me);
    const latest = returning === 'A' ? { id: 'A', name: 'Ada' } : me;
    state.setMe(latest);
    const finalSignIn = returning === 'A' ? state.auth().signIn(latest) : replacement;
    assert.equal(state.auth().roomChanging, true);
    releaseOlder();
    await priorSignIn;
    assert.equal(state.auth().roomChanging, true);
    await until(() => state.forgotten.length === 1);
    assert.equal(state.auth().roomChanging, true);
    releaseCleanup();
    await replacement;
    await finalSignIn;
    assert.equal(state.auth().account.id, returning);
    assert.equal(state.auth().roomChanging, false);
  });
}

test('a reload with cleanup owed starts with the room hidden and waits for the wipe', async (t) => {
  const state = await account(t);
  await state.engine.finishSignOut({ choice: 'keep', deviceCleanup: true });
  let release;
  const cleanup = new Promise((resolve) => { release = resolve; });
  roadmapRoutes.forgetDevice.mock.mockImplementation(async (change) => {
    state.forgotten.push(change);
    await cleanup;
  });
  state.setMe({ id: 'B', name: 'Bea' });
  await state.reload();
  assert.equal(state.auth().roomChanging, true);
  await until(() => state.forgotten.length === 1);
  assert.equal(state.auth().roomChanging, true);
  release();
  await until(() => state.auth().status === 'signed-in');
  assert.equal(state.auth().account.id, 'B');
  assert.equal(state.auth().roomChanging, false);
});

test('failed replacement cleanup keeps the room hidden until a successful retry', async (t) => {
  const state = await account(t);
  roadmapRoutes.forgetDevice.mock.mockImplementation(() => { throw new Error('device-cleanup-refused'); });
  const me = { id: 'B', name: 'Bea' };
  state.setMe(me);
  await assert.rejects(state.auth().signIn(me), /device-cleanup-refused/);
  assert.equal(state.auth().roomChanging, true);
  assert.equal(state.engine.device.meta.deviceCleanup.previous, 'A');
  roadmapRoutes.forgetDevice.mock.mockImplementation((change) => state.forgotten.push(change));
  await state.auth().refresh();
  assert.equal(state.auth().account.id, 'B');
  assert.equal(state.auth().roomChanging, false);
});

test('an explicit sign-out broadcast still clears roadmap work instead of becoming a lapse', async (t) => {
  const state = await account(t);
  state.setMe(null);
  state.broadcasts[0].onmessage({ data: { type: 'signed-out' } });
  await until(() => state.auth().status === 'ghost');
  assert.deepEqual(state.forgotten, [{ previous: 'A', next: null }]);
  assert.equal(state.auth().lapsed, false);
  assert.equal(state.engine.device.activeReplica.meta.state, 'anon');
});

test('an account closed here tells each product its departure was a closure', async (t) => {
  const state = await account(t);
  let me = { id: 'A', name: 'Ada' };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const answer = (status, body = {}) => ({ ok: status < 300, status, json: async () => body });
    const path = new URL(url, 'https://windmill.works').pathname;
    if (path === '/v1/sessions') return answer(200, { sessions: [{ id: 's1', current: true }] });
    if (path === '/v1/me' && init.method === 'DELETE') return answer(200, { closingOn: '2026-12-24', closesMs: 1 });
    if (path === '/v1/auth/logout') { me = null; return answer(200); }
    return me ? answer(200, { user: me, signInMethods: [] }) : answer(401);
  });
  const closing = state.auth().closeAccount('A');
  await until(() => state.engine.device.meta.signOut);
  state.env.timers.advance(state.engine.limits.SIGNOUT_FLUSH_MS);
  await closing;
  assert.deepEqual({ forgotten: state.forgotten, status: state.auth().status, closing: state.engine.device.meta.closingAccount ?? null },
    { forgotten: [{ previous: 'A', next: null, closed: true }], status: 'ghost', closing: null });
});

test('a tab that missed sign-out broadcast recognizes the completed replica transition on refresh', async (t) => {
  const state = await account(t);
  await state.engine.finishSignOut({ choice: 'keep' });
  await state.engine.write(null, (device) => { delete device.meta.clearCredential; });
  state.setMe(null);
  await state.auth().refresh();
  assert.deepEqual(state.forgotten, [{ previous: 'A', next: null }]);
  assert.deepEqual({ status: state.auth().status, lapsed: state.auth().lapsed }, { status: 'ghost', lapsed: false });
});

test('the refused-device line stands in the shell until a surface that says it holds it, and comes back when that surface goes', async (t) => {
  const state = await account(t);
  syncSession.getSnapshot.mock.mockImplementation(() => ({ engine: state.engine, ready: false, online: true, error: true }));
  const said = () => elementsOf(state.view.tree).filter((node) => node.props.role === 'alert').map(textOf);
  state.view.redraw();
  assert.deepEqual(said(), ['Couldn’t open this device’s saved work. Reload to try again.']);
  const release = state.auth().holdDeviceLine();
  assert.deepEqual(said(), []);
  release();
  assert.deepEqual(said(), ['Couldn’t open this device’s saved work. Reload to try again.']);
});

test('the global offline notice yields only to a published offline status, including an anonymous device owner', async (t) => {
  const state = await account(t);
  state.setMe(null);
  await state.auth().refresh();
  syncSession.getSnapshot.mock.mockImplementation(() => ({ engine: state.engine, ready: true, online: false, error: false }));
  const notices = () => elementsOf(state.view.tree).filter((node) => node.props.role === 'status').map(textOf);
  const offlineNotice = ['Offline. Coach, echoes, nudges, voice and export need a connection.'];
  state.view.redraw();
  assert.deepEqual(notices(), offlineNotice);
  const { registerRoomStatus } = await loadScreen('shell/roomStatus.js');
  const room = registerRoomStatus();
  t.after(room.release);
  state.view.redraw();
  assert.deepEqual(notices(), offlineNotice);
  for (const status of [
    { line: ANONYMOUS_OWNER, narrow: 'device' },
    { line: LAPSED_SESSION, narrow: 'device' },
    { line: SYNC_STATUS.saving, narrow: 'announce' },
    { line: SYNC_STATUS.offline },
  ]) {
    room.publish(status);
    state.view.redraw();
    assert.deepEqual(notices(), offlineNotice);
  }
  room.publish({ line: SYNC_STATUS.offline, connectivity: 'offline' });
  state.view.redraw();
  assert.deepEqual(notices(), []);
  room.publish(null);
  state.view.redraw();
  assert.deepEqual(notices(), offlineNotice);
  room.release();
  state.view.redraw();
  assert.deepEqual(notices(), offlineNotice);
});

for (const returning of ['A', 'B']) {
  test(`a lapsed document reload restores the durable holder before ${returning} signs in`, async (t) => {
    const state = await account(t);
    state.setMe(null);
    await state.auth().refresh();
    await state.reload();
    await until(() => state.auth().status === 'ghost');
    assert.equal(state.auth().lapsed, true);
    assert.deepEqual(state.forgotten, []);
    const user = { id: returning, name: returning };
    state.setMe(user);
    await state.auth().signIn(user);
    assert.deepEqual(state.forgotten, returning === 'A' ? [] : [{ previous: 'A', next: 'B' }]);
    assert.equal(state.auth().status, 'signed-in');
    assert.equal(state.engine.device.activeReplica.meta.account, returning);
    assert.deepEqual(state.engine.device.activeReplica.outbox, returning === 'A' ? state.entries : []);
    assert.deepEqual(state.env.failures, []);
  });
}


for (const interruption of ['question', 'handshake']) {
  test(`an interrupted account replacement keeps cleanup owed through a ${interruption} and reload`, async (t) => {
    const state = await account(t);
    state.setMe(null);
    await state.auth().refresh();
    await state.engine.finishSignOut({ choice: 'keep', deviceCleanup: true });
    state.setMe({ id: 'B', name: 'Bea' });
    if (interruption === 'question')
      await state.engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'anon0001', f: { title: 'anonymous' } }]);
    state.env.transport.response = () => ({ response: interruption === 'handshake'
      ? { status: 503, body: {} }
      : { status: 200, body: { as: 'B', holdsRecords: { probe: true }, epoch: 'ep-1', serverTime: 1000, schema: 1, minSchema: 1 } },
      timing: { send: state.engine.reading(), recv: state.engine.reading() } });
    const result = await state.engine.signIn('B');
    assert.equal(result.complete, false);
    assert.equal(interruption === 'question' ? result.due[0].kind : result.authPaused, interruption === 'question' ? 'signed-out' : true);
    assert.deepEqual(state.engine.device.meta.deviceCleanup, { previous: 'A', generation: 2 });
    assert.deepEqual(state.forgotten, []);
    if (interruption === 'handshake') state.env.transport.response = null;
    await state.reload();
    await until(() => state.forgotten.length === 1);
    await until(() => state.engine.device.meta.deviceCleanup === undefined);
    if (interruption === 'question') {
      await until(() => elementsOf(state.view.tree).some((node) => node.props.onDecision && node.props.question));
      const decision = elementsOf(state.view.tree).find((node) => node.props.onDecision);
      await decision.props.onDecision('add');
    }
    await until(() => state.auth().status === 'signed-in');
    assert.deepEqual(state.forgotten, [{ previous: 'A', next: null }]);
    assert.equal(state.engine.device.activeReplica.meta.account, 'B');
    assert.equal(state.engine.device.meta.deviceCleanup, undefined);
  });
}

test('an explicit sign-out interrupted before the product wipe resumes it while signed out after reload', async (t) => {
  const state = await account(t);
  await state.engine.finishSignOut({ choice: 'keep', deviceCleanup: true });
  state.setMe(null);
  assert.deepEqual(state.engine.device.meta.deviceCleanup, { previous: 'A', generation: 2 });
  assert.deepEqual(state.forgotten, []);
  await state.reload();
  await until(() => state.auth().status === 'ghost');
  assert.deepEqual(state.forgotten, [{ previous: 'A', next: null }]);
  assert.equal(state.engine.device.meta.deviceCleanup, undefined);
  assert.equal(state.auth().lapsed, false);
});

test('a failed product wipe retains its durable intent until a later refresh succeeds', async (t) => {
  const state = await account(t);
  await state.engine.finishSignOut({ choice: 'keep', deviceCleanup: true });
  state.setMe(null);
  let attempts = 0;
  roadmapRoutes.forgetDevice.mock.mockImplementation((change) => {
    attempts++;
    if (attempts === 1) throw new Error('device-cleanup-refused');
    state.forgotten.push(change);
  });
  await state.reload();
  await until(() => elementsOf(state.view.tree).some((node) => node.props.role === 'alert'));
  assert.deepEqual(state.engine.device.meta.deviceCleanup, { previous: 'A', generation: 2 });
  assert.deepEqual(state.forgotten, []);
  await state.auth().refresh();
  assert.equal(attempts, 2);
  assert.deepEqual(state.forgotten, [{ previous: 'A', next: null }]);
  assert.equal(state.engine.device.meta.deviceCleanup, undefined);
});

test('an incomplete discard decision does not owe product cleanup', async (t) => {
  const state = await account(t);
  const result = await state.engine.finishSignOut({ choice: 'discard', counted: [], deviceCleanup: true });
  assert.equal(result.complete, false);
  assert.equal(state.engine.device.activeReplica.meta.state, 'bound');
  assert.equal(state.engine.device.meta.deviceCleanup, undefined);
  assert.deepEqual(state.forgotten, []);
});


test('a failed explicit sign-out wipe retries in the same document after the replica is anonymous', async (t) => {
  const state = await account(t);
  state.engine.online = false;
  state.setMe(null);
  let attempts = 0;
  roadmapRoutes.forgetDevice.mock.mockImplementation((change) => {
    attempts++;
    if (attempts === 1) throw new Error('device-cleanup-refused');
    state.forgotten.push(change);
  });
  const finished = state.auth().signOut();
  await until(() => elementsOf(state.view.tree).some((node) => node.props.onDecision && node.props.question));
  const decision = () => elementsOf(state.view.tree).find((node) => node.props.onDecision);
  await decision().props.onDecision('keep');
  assert.equal(state.engine.device.activeReplica.meta.state, 'anon');
  assert.deepEqual(state.engine.device.meta.deviceCleanup, { previous: 'A', generation: state.engine.device.meta.authGeneration });
  assert.equal(decision().props.error, true);
  await decision().props.onDecision('keep');
  assert.equal(await finished, true);
  assert.equal(state.engine.device.meta.deviceCleanup, undefined);
  assert.deepEqual(state.forgotten.map(({ navigation, ...change }) => change), [{ previous: 'A', next: null }]);
  assert.equal(typeof state.forgotten[0].navigation.navigate, 'function');
  assert.deepEqual({ status: state.auth().status, lapsed: state.auth().lapsed }, { status: 'ghost', lapsed: false });
});

test('replaying stored cleanup never confirms a stored arriving account', async (t) => {
  const state = await account(t);
  await state.engine.finishSignOut({ choice: 'keep', deviceCleanup: true });
  await state.engine.write(null, (device) => { device.meta.deviceCleanup.next = 'B'; });
  state.setMe(null);
  const { confirmDeviceOwner, deviceOwner } = await import('../../../src/products/roadmap/persistence/LocalTreeRegistry.js');
  roadmapRoutes.forgetDevice.mock.mockImplementation((change) => {
    state.forgotten.push(change);
    confirmDeviceOwner(change.next);
  });
  await state.reload();
  await until(() => state.auth().status === 'ghost');
  assert.deepEqual(state.forgotten, [{ previous: 'A', next: null }]);
  assert.equal(deviceOwner(), null);
});


test('finishing an old cleanup cannot acknowledge a newer departure by the same account', async (t) => {
  const state = await account(t);
  await state.engine.finishSignOut({ choice: 'keep', deviceCleanup: true });
  state.setMe(null);
  let started;
  let release;
  const began = new Promise((resolve) => { started = resolve; });
  const delayed = new Promise((resolve) => { release = resolve; });
  roadmapRoutes.forgetDevice.mock.mockImplementation(async () => { started(); await delayed; });
  const refresh = state.auth().refresh();
  await began;
  await state.engine.write(null, (device) => {
    device.meta.authGeneration++;
    device.meta.deviceCleanup = { previous: 'A', generation: device.meta.authGeneration };
  });
  const newer = structuredClone(state.engine.device.meta.deviceCleanup);
  release();
  await refresh;
  assert.deepEqual(state.engine.device.meta.deviceCleanup, newer);
});

test('voluntary sign-out waits for admission before engine cleanup and cancellation leaves the account intact', async (t) => {
  const state = await account(t);
  state.engine.online = false;
  const begin = t.mock.method(state.engine, 'beginSignOut');
  let notice;
  const release = registerNavigationGuard({ blocked: ({ kind }) => kind === 'sign-out', onBlocked: (value) => { notice = value; }, onUnrestorableNavigation() {} });
  t.after(release);
  const cancelled = state.auth().signOut();
  assert.deepEqual(notice.context, { kind: 'sign-out' });
  assert.equal(Object.isFrozen(notice.context), true);
  assert.equal(state.auth().signOut(), cancelled);
  assert.equal(begin.mock.callCount(), 0);
  assert.equal(state.auth().roomChanging, false);
  assert.equal(state.auth().status, 'signed-in');
  assert.deepEqual(state.forgotten, []);
  notice.cancel();
  notice.proceed();
  assert.equal(await cancelled, false);
  assert.equal(begin.mock.callCount(), 0);

  const allowed = state.auth().signOut();
  assert.equal(state.auth().signOut(), allowed);
  notice.proceed();
  notice.proceed();
  await until(() => elementsOf(state.view.tree).some((node) => node.props.onDecision && node.props.question));
  assert.equal(begin.mock.callCount(), 1);
  const decision = elementsOf(state.view.tree).find((node) => node.props.onCancel && node.props.onDecision);
  await decision.props.onCancel();
  assert.equal(await allowed, false);
  assert.equal(state.auth().status, 'signed-in');
  assert.deepEqual(state.forgotten, []);
});

test('an observed replacement account completes security cleanup without asking the voluntary guard', async (t) => {
  const state = await account(t);
  const release = registerNavigationGuard({ blocked: () => true,
    onBlocked() { assert.fail('account replacement is forced cleanup'); }, onUnrestorableNavigation() {} });
  t.after(release);
  state.setMe({ id: 'B', name: 'Bea' });
  await state.auth().refresh();
  assert.deepEqual(state.forgotten, [{ previous: 'A', next: 'B' }]);
  assert.equal(state.auth().account.id, 'B');
  assert.equal(state.auth().roomChanging, false);
});

test('document scope fences before replacement publication and reuses the ticket through cleanup', async (t) => {
  const state = await account(t);
  const scope = state.auth().dataScope;
  assert.deepEqual(scope.getSnapshot(), { epoch: 1, phase: 'ready', owner: { kind: 'account', id: 'A' } });
  const previous = scope.getSnapshot();
  const invalidations = [];
  t.mock.method(roadmapRoutes.session, 'invalidateAccount', () => invalidations.push(scope.getSnapshot()));
  let release;
  const cleanup = new Promise((resolve) => { release = resolve; });
  roadmapRoutes.forgetDevice.mock.mockImplementation(() => cleanup);
  state.setMe({ id: 'B', name: 'Bea' });
  const signIn = state.auth().signIn({ id: 'B', name: 'Bea' });
  assert.deepEqual(scope.getSnapshot(), { epoch: previous.epoch + 1, phase: 'changing', owner: { kind: 'account', id: 'B' } });
  assert.equal(state.auth().account.id, 'A');
  await until(() => state.engine.device.meta.deviceCleanup);
  assert.equal(invalidations.length, 1);
  release();
  await signIn;
  assert.deepEqual(scope.getSnapshot(), { epoch: previous.epoch + 1, phase: 'ready', owner: { kind: 'account', id: 'B' } });
});

test('cancelled sign-out preparation and pre-commit failure preserve scope, but attempted cleanup remains fenced', async (t) => {
  const state = await account(t);
  state.engine.online = false;
  const before = state.auth().dataScope.getSnapshot();
  const pending = state.auth().signOut();
  await until(() => elementsOf(state.view.tree).some((node) => node.props.onDecision && node.props.question));
  const decision = () => elementsOf(state.view.tree).find((node) => node.props.onDecision);
  assert.equal(state.auth().dataScope.getSnapshot(), before);
  await decision().props.onCancel();
  assert.equal(await pending, false);
  assert.equal(state.auth().dataScope.getSnapshot(), before);
  const again = state.auth().signOut();
  await until(() => decision().props.question);
  const transact = state.engine.store.transact.bind(state.engine.store);
  state.engine.store.transact = () => Promise.reject(new Error('pre-commit store failure'));
  await decision().props.onDecision('keep');
  assert.equal(state.auth().dataScope.getSnapshot(), before);
  state.engine.store.transact = (change, options) => transact(change, { ...options, beforeCommit: ({ transaction }) => transaction.abort() });
  await decision().props.onDecision('keep');
  const fenced = state.auth().dataScope.getSnapshot();
  assert.deepEqual(fenced, { epoch: before.epoch + 1, phase: 'changing', owner: { kind: 'anonymous' } });
  state.engine.store.transact = transact;
  await decision().props.onCancel();
  assert.equal(await again, false);
  assert.equal(state.auth().dataScope.getSnapshot(), fenced);
});

test('lapse preserves scope and a missed completed sign-out fences the old owner on reconciliation', async (t) => {
  const state = await account(t);
  const scope = state.auth().dataScope;
  const before = scope.getSnapshot();
  state.setMe(null);
  await state.auth().refresh();
  assert.equal(scope.getSnapshot(), before);
  await state.engine.finishSignOut({ choice: 'keep' });
  await state.engine.write(null, (device) => { delete device.meta.clearCredential; });
  await state.auth().refresh();
  assert.deepEqual(scope.getSnapshot(), { epoch: before.epoch + 1, phase: 'ready', owner: { kind: 'anonymous' } });
});

test('a throwing product invalidator cannot stop the scope fence, later invalidators or cleanup', async (t) => {
  const state = await account(t);
  const { PRODUCTS } = await import('../../../src/shell/products.js');
  const afterRoadmap = PRODUCTS.find((product) => product.id !== 'roadmap');
  const previous = afterRoadmap.session;
  const observations = [];
  afterRoadmap.session = { invalidateAccount: () => observations.push(state.auth().dataScope.getSnapshot()) };
  t.after(() => { if (previous) afterRoadmap.session = previous; else delete afterRoadmap.session; });
  t.mock.method(roadmapRoutes.session, 'invalidateAccount', () => { throw new Error('Private draft value must not escape'); });
  const before = state.auth().dataScope.getSnapshot();
  state.setMe({ id: 'B', name: 'Bea' });
  await state.auth().signIn({ id: 'B', name: 'Bea' });
  assert.deepEqual(observations, [{ epoch: before.epoch + 1, phase: 'changing', owner: { kind: 'account', id: 'B' } }]);
  assert.deepEqual(state.auth().dataScope.getSnapshot(), { epoch: before.epoch + 1, phase: 'ready', owner: { kind: 'account', id: 'B' } });
  assert.deepEqual(state.forgotten, [{ previous: 'A', next: 'B' }]);
});

test('the same sign-out callback is idempotent and an old callback cannot fence a newer account', async (t) => {
  const state = await account(t);
  state.engine.online = false;
  const finish = state.engine.finishSignOut.bind(state.engine);
  const callbacks = [];
  const invalidations = [];
  t.mock.method(roadmapRoutes.session, 'invalidateAccount', () => invalidations.push(state.auth().dataScope.getSnapshot()));
  state.engine.finishSignOut = (options) => finish({ ...options, beforeSignOutCommit: () => {
    callbacks.push(options.beforeSignOutCommit);
    options.beforeSignOutCommit();
    options.beforeSignOutCommit();
  } });
  const departure = state.auth().signOut();
  const decision = () => elementsOf(state.view.tree).find((node) => node.props.onDecision);
  await until(() => decision()?.props.question);
  await decision().props.onDecision('keep');
  assert.equal(await departure, true);
  assert.equal(invalidations.length, 1);
  state.setMe({ id: 'B', name: 'Bea' });
  await state.auth().signIn({ id: 'B', name: 'Bea' });
  const current = state.auth().dataScope.getSnapshot();
  assert.equal(current.owner.id, 'B');
  assert.throws(callbacks[0], { message: 'stale document data transition' });
  assert.equal(state.auth().dataScope.getSnapshot(), current);
});


test('online sign-out completes its anonymous scope and accepts a new draft after a 401 refresh', async (t) => {
  const state = await account(t);
  const scope = state.auth().dataScope;
  const before = scope.getSnapshot();
  const transitions = [];
  t.after(scope.subscribe(() => transitions.push(scope.getSnapshot())));
  let loggedOut = false;
  globalThis.fetch.mock.mockImplementation(async (url) => {
    if (String(url).endsWith('/auth/logout')) {
      loggedOut = true; state.setMe(null);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: !loggedOut, status: loggedOut ? 401 : 200,
      json: async () => ({ user: loggedOut ? null : { id: 'A', name: 'Ada' } }) };
  });
  const departure = state.auth().signOut();
  const decision = () => elementsOf(state.view.tree).find((node) => node.props.onDecision);
  await until(() => state.engine.signoutTimer !== undefined);
  state.env.timers.advance(state.engine.limits.SIGNOUT_FLUSH_MS + 1);
  await until(() => decision()?.props.question);
  await decision().props.onDecision('keep');
  assert.equal(await departure, true);
  await state.auth().refresh();
  assert.equal(state.engine.device.activeReplica.meta.state, 'anon');
  assert.equal(state.engine.device.meta.clearCredential, undefined);
  assert.equal(state.engine.device.meta.deviceCleanup, undefined);
  assert.equal(state.auth().status, 'ghost');
  assert.deepEqual(transitions, [
    { epoch: before.epoch + 1, phase: 'changing', owner: { kind: 'anonymous' } },
    { epoch: before.epoch + 1, phase: 'ready', owner: { kind: 'anonymous' } },
  ]);
  const { StepDraftSession } = await import('../../../src/products/roadmap/step/StepDraftSession.js');
  const drafts = new StepDraftSession();
  drafts.bindScope(scope);
  assert.notEqual(drafts.start({ draft: { field: 'label' }, displayValue: 'Anonymous edit' }), null);
});

test('a different cookie owner during committed sign-out fences its own scope before cleanup continues', async (t) => {
  const state = await account(t);
  const clear = state.engine.credentials.clear, answers = [];
  state.engine.credentials.clear = async (account) => { const gone = await clear(account); answers.push(gone); return gone; };
  const scope = state.auth().dataScope;
  const before = scope.getSnapshot();
  const transitions = [];
  t.after(scope.subscribe(() => transitions.push(scope.getSnapshot())));
  const cleanupScopes = [];
  roadmapRoutes.forgetDevice.mock.mockImplementation(() => cleanupScopes.push(scope.getSnapshot()));
  let answer;
  const cookie = new Promise((resolve) => { answer = resolve; });
  let reads = 0;
  globalThis.fetch.mock.mockImplementation(async (url) => {
    assert.equal(String(url).endsWith('/auth/logout'), false);
    reads++;
    if (reads === 1) return cookie;
    return { ok: true, status: 200, json: async () => ({ user: { id: 'B', name: 'Bea' } }) };
  });
  const departure = state.auth().signOut();
  const decision = () => elementsOf(state.view.tree).find((node) => node.props.onDecision);
  await until(() => state.engine.signoutTimer !== undefined);
  state.env.timers.advance(state.engine.limits.SIGNOUT_FLUSH_MS + 1);
  await until(() => decision()?.props.question);
  const finish = decision().props.onDecision('keep');
  await until(() => reads === 1);
  assert.deepEqual(scope.getSnapshot(), { epoch: before.epoch + 1, phase: 'changing', owner: { kind: 'anonymous' } });
  state.setMe({ id: 'B', name: 'Bea' });
  answer({ ok: true, status: 200, json: async () => ({ user: { id: 'B', name: 'Bea' } }) });
  await finish;
  assert.equal(await departure, true);
  assert.deepEqual(scope.getSnapshot(), { epoch: before.epoch + 2, phase: 'changing', owner: { kind: 'account', id: 'B' } });
  assert.deepEqual(cleanupScopes, [{ epoch: before.epoch + 2, phase: 'changing', owner: { kind: 'account', id: 'B' } }]);
  await state.auth().refresh();
  assert.equal(state.auth().account.id, 'B');
  assert.equal(state.engine.device.activeReplica.meta.account, 'B');
  assert.deepEqual(scope.getSnapshot(), { epoch: before.epoch + 2, phase: 'ready', owner: { kind: 'account', id: 'B' } });
  assert.deepEqual(transitions, [
    { epoch: before.epoch + 1, phase: 'changing', owner: { kind: 'anonymous' } },
    { epoch: before.epoch + 2, phase: 'changing', owner: { kind: 'account', id: 'B' } },
    { epoch: before.epoch + 2, phase: 'ready', owner: { kind: 'account', id: 'B' } },
  ]);
  assert.deepEqual(answers, [false]);
});

test('the credentials port answers that the browser holds no credential once it logged its own account out, or found none', async (t) => {
  const state = await account(t);
  let me = { id: 'A', name: 'Ada' };
  globalThis.fetch.mock.mockImplementation(async (url) => {
    if (String(url).endsWith('/auth/logout')) { me = null; return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: !!me, status: me ? 200 : 401, json: async () => ({ user: me }) };
  });
  const own = await state.engine.credentials.clear('A');
  const none = await state.engine.credentials.clear('A');
  assert.deepEqual({ own, none, loggedOut: globalThis.fetch.mock.calls.filter((call) => String(call.arguments[0]).endsWith('/auth/logout')).length },
    { own: true, none: true, loggedOut: 1 });
});

test('a paused anon replica waits on the shell\'s 20-second read of the account, which releases it once the browser holds no credential, and nothing else asks the server', async (t) => {
  const state = await account(t);
  const engine = state.engine;
  await engine.start();
  await until(() => engine.leader);
  state.setMe(null);
  assert.equal((await engine.finishSignOut({ choice: 'keep' })).complete, true);
  await engine.cleanupCredentials();
  await state.auth().refresh();
  const reads = () => globalThis.fetch.mock.calls.filter((call) => String(call.arguments[0]).endsWith('/v1/me')).length;
  const told = () => state.env.events.filter(({ name }) => name === 'sync-auth-paused').map(({ props }) => props.outcome);
  const before = { reads: reads(), fetches: globalThis.fetch.mock.calls.length, told: told().length };
  await engine.receiveFrame({ op: 'change', scope: 'tree/b_00000001', as: 'A' });
  for (let i = 0; i < 20; i++) { state.env.timers.advance(15_000); await tick(); }
  t.mock.timers.tick(19_999);
  await tick();
  const waited = { state: engine.device.activeReplica.meta.state, authPaused: engine.device.activeReplica.meta.authPaused,
    fetches: globalThis.fetch.mock.calls.length - before.fetches };
  t.mock.timers.tick(1);
  await until(() => engine.device.activeReplica.meta.authPaused === false);
  assert.deepEqual({ waited, reads: reads() - before.reads, fetches: globalThis.fetch.mock.calls.length - before.fetches,
    told: told().slice(before.told), status: state.auth().status, failures: state.env.failures }, {
    waited: { state: 'anon', authPaused: true, fetches: 0 },
    reads: 1, fetches: 1, told: ['paused', 'released'], status: 'ghost', failures: [],
  });
});

test('each sign-in decision due is asked once, in turn, in its product’s own words where it words them, else the shell’s around its count, and each answer pins what its question counted', async (t) => {
  const state = await account(t);
  const steps = [];
  const said = { title: 'Add your roadmaps?', lead: '1 roadmap on this browser can join your account.', items: ['Learn to sail'],
    note: 'Choosing Discard removes this browser roadmap.' };
  const words = { ...said, onStep: (step) => steps.push(step) };
  t.mock.method(journalRoutes.sync, 'adoptionAnswer', () => null);
  t.mock.method(journalRoutes.sync, 'adoptionCount', () => 2);
  const sync = roadmapRoutes.sync;
  roadmapRoutes.sync = { signInWords: async (engine, due) => (due.product === 'roadmap' ? words : null) };
  t.after(() => { roadmapRoutes.sync = sync; });
  const due = [{ kind: 'signed-out', product: 'journal', count: { page: 3 }, counted: ['j1'] },
    { kind: 'signed-out', product: 'roadmap', count: { tree: 1, meta: 1 }, counted: ['r1', 'r2'] }];
  const answered = [];
  t.mock.method(state.engine, 'signIn', async (_account, answers = {}) => {
    answered.push(answers);
    return { complete: due.every((question) => answers.decisions?.[question.product]), due };
  });
  const decision = () => elementsOf(state.view.tree).find((node) => node.props.onDecision);
  const asked = () => {
    const { product, words: worded } = decision().props.question;
    const { onStep, ...shown } = worded;
    onStep('shown');
    return { product, words: shown };
  };

  await state.auth().signIn({ id: 'A', name: 'Ada' });
  const first = asked();
  await decision().props.onDecision('add');
  const second = asked();
  await decision().props.onDecision('discard');
  assert.deepEqual({ first, second, last: decision().props.question, answered, status: state.auth().status, steps }, {
    first: { product: 'journal', words: { title: 'Add to your account?',
      lead: 'This browser has 2 pages from before you signed in. Your account already has pages.', items: [{ label: '2 pages' }],
      note: 'Add them, or discard them from this browser.', discard: { title: 'Discard 2 pages?', body: 'They are deleted from this browser. You can’t undo this.' } } },
    second: { product: 'roadmap', words: said },
    steps: ['shown'],
    last: null,
    answered: [{}, { decisions: { journal: 'add' }, counted: { journal: ['j1'] } },
      { decisions: { journal: 'add', roadmap: 'discard' }, counted: { journal: ['j1'], roadmap: ['r1', 'r2'] } }],
    status: 'signed-in',
  });
});

test('cancelling a sign-in its product words keeps the work from before on the device, unsent, and signs the account out of it', async (t) => {
  const state = await account(t);
  state.setMe(null);
  state.broadcasts[0].onmessage({ data: { type: 'signed-out' } });
  await until(() => state.auth().status === 'ghost');
  await state.engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'card0002', f: { title: 'made signed out' } }]);
  const request = state.env.transport.request.bind(state.env.transport);
  state.env.transport.request = async (endpoint, body) => {
    const answer = await request(endpoint, body);
    if (endpoint === 'hello' && answer.response.body.holdsRecords) answer.response.body.holdsRecords.probe = true;
    return answer;
  };
  const steps = [];
  const said = { title: 'Add your cards?', lead: '1 card on this browser can join your account.', items: ['made signed out'], note: 'Discard removes it.' };
  const probe = { id: 'probe', sync: { signInWords: async () => ({ ...said, onStep: (step) => steps.push(step) }) } };
  PRODUCTS.push(probe);
  t.after(() => PRODUCTS.splice(PRODUCTS.indexOf(probe), 1));

  state.setMe({ id: 'A', name: 'Ada' });
  await state.auth().signIn({ id: 'A', name: 'Ada' });
  const decision = elementsOf(state.view.tree).find((node) => node.props.onDecision);
  const pendingSignIn = structuredClone(state.engine.device.meta.pendingSignIn);
  globalThis.fetch.mock.mockImplementation(async (url) => {
    if (String(url).endsWith('/auth/logout')) { state.setMe(null); return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => ({ user: { id: 'A', name: 'Ada' } }) };
  });
  const { onStep, ...shown } = decision.props.question.words;
  onStep('cancel');
  await decision.props.onCancel();
  const replicas = state.engine.device.replicas.map((replica) => [replica.meta.state, replica.entries().map((entry) => [entry.lineage, entry.scope])]);
  assert.deepEqual({ asked: [decision.props.question.product, shown], steps, pendingSignIn,
    after: { question: elementsOf(state.view.tree).find((node) => node.props.onDecision).props.question, status: state.auth().status,
      pendingSignIn: state.engine.device.meta.pendingSignIn, clearCredential: state.engine.device.meta.clearCredential, replicas },
    loggedOut: globalThis.fetch.mock.calls.filter((call) => String(call.arguments[0]).endsWith('/auth/logout')).length }, {
    asked: ['probe', said],
    steps: ['cancel'],
    pendingSignIn: { account: 'A' },
    after: { question: null, status: 'ghost', pendingSignIn: undefined, clearCredential: undefined,
      replicas: [['anon', [['anon', 'self/probe']]], ['dormant', [['A', 'self/probe']]]] },
    loggedOut: 1,
  });
});

test('a product whose sign-out notice or whose words\' steps throw cannot keep a person from signing out and in: the shell asks without them', async (t) => {
  const state = await account(t);
  state.engine.online = false;
  const thrown = () => { throw new Error('the product chunk did not load'); };
  const words = (title) => ({ title, lead: '1 card on this browser.', items: ['made signed out'], note: 'Discard removes it.', onStep: thrown });
  const probe = { id: 'probe', signOutNotice: thrown,
    sync: { signInWords: async () => words('Add your cards?'), signOutWords: async () => words('Keep your cards?') } };
  PRODUCTS.push(probe);
  t.after(() => PRODUCTS.splice(PRODUCTS.indexOf(probe), 1));
  const decision = () => elementsOf(state.view.tree).find((node) => node.props.onDecision);

  const departure = state.auth().signOut();
  await until(() => decision()?.props.question);
  const signOut = decision().props;
  for (const step of ['shown', 'keep']) signOut.question.words.onStep(step);
  await signOut.onDecision('keep');
  const departed = await departure;

  state.engine.online = true;
  await state.engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'card0002', f: { title: 'made signed out' } }]);
  const request = state.env.transport.request.bind(state.env.transport);
  state.env.transport.request = async (endpoint, body) => {
    const answer = await request(endpoint, body);
    if (endpoint === 'hello' && answer.response.body.holdsRecords) answer.response.body.holdsRecords.probe = true;
    return answer;
  };
  await state.auth().signIn({ id: 'A', name: 'Ada' });
  const signIn = decision().props;
  for (const step of ['shown', 'add']) signIn.question.words.onStep(step);
  await signIn.onDecision('add');
  assert.deepEqual({ departed, notices: signOut.notices, asked: [signOut.question.words.title, signIn.question.words.title],
    status: state.auth().status, replica: state.engine.device.activeReplica.meta.state, question: decision().props.question },
  { departed: true, notices: [], asked: ['Keep your cards?', 'Add your cards?'], status: 'signed-in', replica: 'bound', question: null });
});

test('a product whose sign-out words throw cannot keep a person from signing out: the shell asks in its own words', async (t) => {
  const state = await account(t);
  state.engine.online = false;
  const probe = { id: 'probe', sync: { signOutWords: async () => { throw new Error('the product chunk did not load'); } } };
  PRODUCTS.push(probe);
  t.after(() => PRODUCTS.splice(PRODUCTS.indexOf(probe), 1));
  const departure = state.auth().signOut();
  const decision = () => elementsOf(state.view.tree).find((node) => node.props.onDecision);
  await until(() => decision()?.props.question);
  assert.deepEqual(decision().props.question, { complete: false, unsent: 1, ready: 1, sent: 0, counted: [state.entries[0].localId] });
  await decision().props.onDecision('keep');
  assert.deepEqual({ departed: await departure, status: state.auth().status, replica: state.engine.device.activeReplica.meta.state },
    { departed: true, status: 'ghost', replica: 'anon' });
});
