import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHook, settle } from '../../gym/harness.mjs';
import { until } from '../../../platform/sync/fakes.js';
import { useRoomLoad } from '../../../../src/products/roadmap/room/useRoomLoad.js';
import { HttpTreeRepository } from '../../../../src/products/roadmap/persistence/HttpTreeRepository.js';
import { SyncSession } from '../../../../src/products/roadmap/sync/SyncSession.js';

import { build } from 'vite';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { confirmDeviceOwner } from '../../../../src/products/roadmap/persistence/LocalTreeRegistry.js';
import { SyncStore } from '../../../../src/products/roadmap/sync/SyncStore.js';
import { syncSession as platformSession } from '../../../../src/platform/sync/session.js';
import { useRoomSyncNotices } from '../../../../src/products/roadmap/sync/useRoomSyncNotices.js';
import { LAPSED_SESSION } from '../../../../src/products/roadmap/copy.js';

function roomProps(treeId) {
  const handle = (current = null) => ({ current });
  const nothing = () => {};
  const scene = new Proxy({}, { get: () => nothing });
  return {
    treeId, demo: false, shared: false, demotion: null, breakpoint: 'desktop', placeKept: false,
    room: { sceneRef: handle(scene), sessionRef: handle(), projectionRef: handle(), treeRef: handle(), seedRef: handle(), peersRef: handle(new Map()) },
    scene: null, framing: { firstFrameRef: handle(), insetsRef: handle() }, structure: { layoutRef: handle(), layoutPositions: () => new Map(), install: nothing },
    progressActs: { adoptLoaded: nothing }, activity: { seedActivity: nothing }, legend: { hydrateLegend: nothing },
    workspace: { hydrateWorkspaces: nothing, pushArcs: nothing }, selection: { selectedId: null, selectedIdRef: handle(), setSelectedId: nothing },
    dismissToast: nothing, desktopEditorRef: handle(false), onRemoteProgress: nothing,
  };
}

// Bundle the real read boundary with a counting Sentry sink, sharing React and device state with the harness.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const bundled = new Set(['products/roadmap/room/useRoomLoad.js', 'products/roadmap/persistence/HttpTreeRepository.js', 'products/roadmap/reportFailure.js']
  .map((path) => resolve(root, 'src', path)));
const require = createRequire(import.meta.url);
const result = await build({ configFile: false, root, logLevel: 'silent', plugins: [{
  name: 'room-load-reporting', enforce: 'pre',
  resolveId(id, importer) {
    if (id === 'room-load-entry') return id;
    if (id === 'react') return { id: pathToFileURL(require.resolve('react')).href, external: true };
    const file = id.startsWith('.') && importer ? resolve(dirname(importer), id) : id;
    if (file.endsWith('/telemetry/sentry.js')) return 'room-load-sentry';
    if (bundled.has(file)) return file;
    if (file.startsWith('/')) return { id: pathToFileURL(file).href, external: true };
  },
  load(id) {
    if (id === 'room-load-entry') return `export { useRoomLoad } from ${JSON.stringify(resolve(root, 'src/products/roadmap/room/useRoomLoad.js'))};
      export { HttpTreeRepository } from ${JSON.stringify(resolve(root, 'src/products/roadmap/persistence/HttpTreeRepository.js'))};`;
    if (id === 'room-load-sentry') return 'export function captureError(kind, operation, stack) { globalThis.roomLoadIssues.push({ operation, stack }); }';
  },
}], build: { write: false, minify: false, rollupOptions: { input: 'room-load-entry', preserveEntrySignatures: 'strict', output: { format: 'es', inlineDynamicImports: true } } } });
const captured = await import(`data:text/javascript;base64,${Buffer.from(result.output[0].code).toString('base64')}`);

test('a lapsed cold room loads its owned replica and presents the existing signed-out device line', async (t) => {
  globalThis.roomLoadIssues = [];
  t.after(() => { delete globalThis.roomLoadIssues; });
  const disk = new Map([['windmill:device-trees', JSON.stringify({ t_kept: { title: 'Kept roadmap', owner: 'A', claimed: true } })]]);
  const storage = { getItem: (key) => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value) };
  const globals = {
    window: { location: { search: '', hash: '#/app/t_kept' }, localStorage: storage, setTimeout: () => 0 },
    localStorage: storage,
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  const priorOpening = platformSession.opening;
  let restore;
  platformSession.opening = new Promise((resolve) => { restore = resolve; });
  t.after(() => { platformSession.opening = priorOpening; });
  const saved = { frame: { nodes: [{ id: 'pending', createdAt: '1:0:device', label: 'Unsynced step', labelAt: '1:0:device' }], edges: [], kinds: [] }, lastSeq: 0 };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401 }));
  const loads = t.mock.method(SyncStore.prototype, 'load', async () => saved);
  t.mock.method(SyncSession.prototype, 'start', function () { return this; });
  const props = roomProps('t_kept');
  props.structure.layoutPositions = () => new Map([['pending', { x: 0, y: 0 }]]);
  let accountId = null;
  const view = renderHook(t, () => captured.useRoomLoad({ ...props, accountId }));
  await settle();
  assert.equal(loads.mock.callCount(), 0, 'the room waits for durable identity before reading a blob');
  restore({ device: { meta: {}, activeReplica: { meta: { state: 'bound', account: 'A', authPaused: true } } } });
  await until(() => !view.tree.loading);
  assert.deepEqual({ error: view.tree.loadError, owner: view.tree.treeMine, title: props.room.treeRef.current.title,
    labels: [...props.room.treeRef.current.nodes.values()].map((node) => node.label) },
  { error: false, owner: true, title: 'Kept roadmap', labels: ['Unsynced step'] });
  const notices = renderHook(t, () => useRoomSyncNotices({ treeId: 't_kept', syncSession: view.tree.syncSession,
    owner: view.tree.treeMine, status: 'ghost', lapsed: true, phone: false,
    openSignInDoor() {}, setBoardQuiet() {} }));
  assert.equal(notices.tree.deviceLine.text, LAPSED_SESSION);
  assert.deepEqual(saved.frame.nodes, [{ id: 'pending', createdAt: '1:0:device', label: 'Unsynced step', labelAt: '1:0:device' }]);
  accountId = 'A';
  view.redraw();
  await settle();
  assert.equal(loads.mock.callCount(), 1, 'the returning account retains the open replica for reconnect');
  assert.deepEqual(globalThis.roomLoadIssues, []);
});

for (const arrivesDuringRead of [false, true]) for (const startedSignedIn of [false, true]) for (const available of [false, true]) {
  test(`sign-in retries an unavailable room: ${arrivesDuringRead ? 'during' : 'after'} read, ${startedSignedIn ? 'same account lapses' : 'anonymous visit'}, retry ${available ? 'loads' : 'unavailable'}`, async (t) => {
    const previous = globalThis.window;
    globalThis.window = { location: { search: '', hash: '#/app/t_kept' }, localStorage: { getItem: () => null, setItem() {} } };
    t.after(() => { globalThis.window = previous; });
    let accountId = startedSignedIn ? 'A' : null;
    let reads = 0;
    let finishFirst;
    const pendingFirst = new Promise((resolve) => { finishFirst = resolve; });
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ user: accountId ? { id: accountId } : null }) }));
    t.mock.method(HttpTreeRepository.prototype, 'loadTree', async () => {
      reads++;
      if (reads === 1) { await pendingFirst; return null; }
      if (!available) return null;
      return { id: 't_kept', title: 'Kept roadmap', nodes: [], mine: true };
    });
    t.mock.method(HttpTreeRepository.prototype, 'loadProgress', async () => ({ completed: new Set(), completedAt: {} }));
    t.mock.method(HttpTreeRepository.prototype, 'loadActivity', async () => []);
    t.mock.method(SyncSession.prototype, 'start', function () { return this; });
    const props = roomProps('t_kept');
    const view = renderHook(t, () => useRoomLoad({ ...props, accountId }));
    await until(() => reads === 1);
    if (startedSignedIn) { accountId = null; view.redraw(); }
    if (arrivesDuringRead) { accountId = 'A'; view.redraw(); }
    finishFirst();
    if (!arrivesDuringRead) {
      await until(() => view.tree.loadError);
      accountId = 'A';
      view.redraw();
    }
    await until(() => reads === 2 && !view.tree.loading);
    assert.equal(reads, 2);
    assert.equal(view.tree.loadError, !available);
    assert.equal(view.tree.treeMine, available);
    assert.equal(props.room.treeRef.current?.title ?? null, available ? 'Kept roadmap' : null);
    view.redraw();
    await settle();
    assert.equal(reads, 2);
    if (available) {
      accountId = null; view.redraw();
      accountId = 'A'; view.redraw();
      await settle();
      assert.equal(reads, 2, 'an already open room reconnects without another read');
    }
  });
}

for (const failure of ['unavailable', '5xx', 'offline', 'thrown']) for (const shellSettlesDuringRead of [false, true]) {
  test(`a signed-in cold load reports ${failure} once when the shell confirms ${shellSettlesDuringRead ? 'during' : 'after'} the read`, async (t) => {
    const issues = [];
    globalThis.roomLoadIssues = issues;
    t.after(() => { delete globalThis.roomLoadIssues; });
    const globals = {
      window: { location: { search: '', hash: '#/app/t_missing' }, localStorage: { getItem: () => null, setItem() {} } },
      document: { visibilityState: 'visible' },
      navigator: { onLine: failure !== 'offline' },
    };
    for (const [key, value] of Object.entries(globals)) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, key);
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
      t.after(() => {
        if (previous) Object.defineProperty(globalThis, key, previous);
        else delete globalThis[key];
      });
    }
    let accountId = null;
    let reads = 0;
    let authReads = 0;
    let releaseRead;
    const reading = new Promise((resolve) => { releaseRead = resolve; });
    const error = new Error('fixture projection failed');
    t.mock.method(globalThis, 'fetch', async (url) => {
      if (url.endsWith('/v1/me')) {
        authReads++;
        if (failure === 'offline') throw new TypeError('offline');
        return { ok: true, status: 200, json: async () => ({ user: { id: 'A' } }) };
      }
      reads++;
      await reading;
      if (failure === 'offline') throw new TypeError('offline');
      if (failure === 'unavailable' || failure === '5xx') return { ok: false, status: failure === '5xx' ? 503 : 404 };
      return { ok: true, status: 200, json: async () => ({ data: { id: 't_missing', title: 'Plan', nodes: [] }, mine: true }) };
    });
    if (failure === 'thrown') t.mock.method(captured.HttpTreeRepository.prototype, 'loadProgress', async () => { throw error; });
    const warn = t.mock.method(console, 'warn', () => {});
    const props = roomProps('t_missing');
    const view = renderHook(t, () => captured.useRoomLoad({ ...props, accountId }));
    if (failure === 'offline') {
      await until(() => authReads > 0);
      await settle();
      assert.equal(reads, 0, 'an unanswered offline owner waits for the shell before reading');
      confirmDeviceOwner('A');
    }
    await until(() => reads === 1);
    if (shellSettlesDuringRead) { accountId = 'A'; view.redraw(); }
    releaseRead();
    await until(() => view.tree.loadError && !view.tree.loading);
    accountId = 'A';
    view.redraw();
    await settle();
    assert.equal(reads, 1);
    assert.equal(authReads, 1, 'the room fallback reuses its completed identity lookup');
    assert.deepEqual(issues.map(({ operation }) => operation), failure === '5xx' ? ['roadmap-tree-load'] : failure === 'thrown' ? ['roadmap-load'] : []);
    assert.equal(issues.every(({ stack }) => typeof stack === 'string' && stack.length > 0), true);
    assert.equal(warn.mock.callCount(), failure === 'thrown' ? 1 : 0);
    assert.deepEqual({ loading: view.tree.loading, error: view.tree.loadError, reloads: view.tree.reloadKey },
      { loading: false, error: true, reloads: 0 });
    view.redraw();
    await settle();
    assert.equal(reads, 1);
  });
}
