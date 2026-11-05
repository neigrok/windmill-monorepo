import test from 'node:test';
import assert from 'node:assert/strict';
import { elementsOf, loadScreen, renderHook, textOf } from '../../products/gym/harness.mjs';
import { environment, until } from '../../platform/sync/fakes.js';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { syncSession } from '../../../src/platform/sync/session.js';
import { roadmapRoutes } from '../../../src/products/roadmap/routes.js';
import { ANONYMOUS_OWNER, LAPSED_SESSION, SYNC_STATUS } from '../../../src/products/roadmap/copy.js';

async function account(t) {
  let view;
  t.after(() => view?.unmount());
  const env = environment();
  const storage = new Map();
  const listeners = new Map();
  const broadcasts = [];
  const globals = {
    window: { location: { hash: '#/app/t_pending' }, setTimeout: () => 0,
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
  t.mock.method(syncSession, 'open', (options) => { engine.credentials = options.credentials; return Promise.resolve(engine); });
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
  return { env, get engine() { return engine; }, auth, get view() { return view; }, forgotten, replica, entries, broadcasts, async reload() {
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
    await auth().signIn({ id: 'A', name: 'Ada' });
    assert.deepEqual({ status: auth().status, lapsed: auth().lapsed, id: engine.device.activeReplica.id,
      authPaused: engine.device.activeReplica.meta.authPaused, outbox: engine.device.activeReplica.outbox },
    { status: 'signed-in', lapsed: false, id: replica, authPaused: false, outbox: entries });
    assert.deepEqual(forgotten, []);
    assert.deepEqual(state.env.failures, []);
  });
}

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

test('an explicit sign-out broadcast still clears roadmap work instead of becoming a lapse', async (t) => {
  const state = await account(t);
  state.setMe(null);
  state.broadcasts[0].onmessage({ data: { type: 'signed-out' } });
  await until(() => state.auth().status === 'ghost');
  assert.deepEqual(state.forgotten, [{ previous: 'A', next: null }]);
  assert.equal(state.auth().lapsed, false);
  assert.equal(state.engine.device.activeReplica.meta.state, 'anon');
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
  assert.deepEqual(state.forgotten, [{ previous: 'A', next: null }]);
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
