import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
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

for (const demo of [false, true]) {
  test(`a signed-out ${demo ? 'demo' : 'public roadmap'} opens after the bounded wait when IndexedDB opening hangs`, async (t) => {
    const previous = globalThis.window;
    globalThis.window = { location: { search: '', hash: demo ? '#/demo' : '#/t/t_public' }, localStorage: { getItem: () => null, setItem() {} } };
    t.after(() => { globalThis.window = previous; });
    const previousOpening = platformSession.opening;
    platformSession.opening = new Promise(() => {});
    t.after(() => { platformSession.opening = previousOpening; });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401 }));
    const reads = t.mock.method(HttpTreeRepository.prototype, 'loadTree', async () => ({ id: 't_public', title: 'Shared roadmap', nodes: [], mine: false }));
    t.mock.method(HttpTreeRepository.prototype, 'loadProgress', async () => ({ completed: new Set(), completedAt: {} }));
    t.mock.method(HttpTreeRepository.prototype, 'loadActivity', async () => []);
    t.mock.method(SyncSession.prototype, 'start', function () { return this; });
    t.mock.method(SyncSession.prototype, 'close', () => {});
    const props = { ...roomProps('t_public'), demo, shared: true };
    const view = renderHook(t, () => useRoomLoad(props));
    await nextTurn();
    t.mock.timers.tick(1999);
    await nextTurn();
    assert.equal(reads.mock.callCount(), 0);
    t.mock.timers.tick(1);
    await until(() => !view.tree.loading);
    assert.deepEqual({ error: view.tree.loadError, owner: view.tree.treeMine, title: props.room.treeRef.current.title, reads: reads.mock.callCount() },
      { error: false, owner: false, title: 'Shared roadmap', reads: 1 });
  });
}

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
  assert.equal(loads.mock.callCount(), 2, 'the returning account retains the open replica for reconnect: its tree and its marks were read once');
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
      if (failure === 'unavailable' || failure === '5xx') return { ok: false, status: failure === '5xx' ? 503 : 404, json: async () => ({}) };
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

// An owner's room over a server that answers each tree read in turn, with the session's socket never opened: the test
// speaks for the session through `emit`. `shown` is every projection the room handed on, `recaps` every return recap.
async function ownerRoom(t, { treeAnswers, stored = null, ledger = null }) {
  globalThis.roomLoadIssues = [];
  t.after(() => { delete globalThis.roomLoadIssues; });
  const disk = new Map([['windmill:device-trees', JSON.stringify({ t_year: { title: 'My year', owner: 'A', claimed: true } })]]);
  if (ledger) disk.set('windmill:return:t_year', JSON.stringify(ledger));
  const storage = { getItem: (key) => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value) };
  const globals = {
    window: { location: { search: '', hash: '#/app/t_year' }, localStorage: storage },
    document: { visibilityState: 'visible' },
    navigator: { onLine: true },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  const answered = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
  const reads = { tree: 0 };
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.endsWith('/v1/me')) return answered({ user: { id: 'A' } });
    if (url.includes('/progress')) return answered({ marks: [{ node: 'plan', status: 'complete', at: '5:0:srv' }] });
    if (url.includes('/activity')) return answered({ events: [] });
    reads.tree += 1;
    return treeAnswers.shift();
  });
  t.mock.method(SyncStore.prototype, 'load', async () => stored);
  const sessions = [];
  t.mock.method(SyncSession.prototype, 'start', function () { sessions.push(this); return this; });
  t.mock.method(SyncSession.prototype, 'close', () => {});
  const shown = [];
  const recaps = [];
  const props = roomProps('t_year');
  props.desktopEditorRef.current = true;
  props.structure.onTreeChanged = (projection) => shown.push(projection);
  props.structure.layoutPositions = (tree) => new Map(tree.nodes.map((step) => [step.id, { x: 0, y: 0 }]));
  props.room.sceneRef.current = new Proxy({}, { get: (scene, key) => (key === 'armReturnRecap' ? (ids) => recaps.push(ids) : () => {}) });
  const view = renderHook(t, () => captured.useRoomLoad({ ...props, accountId: 'A' }));
  await until(() => !view.tree.loading);
  return {
    view, props, shown, recaps, reads, storage,
    session: () => sessions.at(-1),
    emit(projection, { joined }) {
      sessions.at(-1).joinedServer = joined;
      sessions.at(-1).treeHandler(projection);
    },
    faces: (projection) => Object.fromEntries(projection.nodes.map((step) => [step.id, step.opening?.face ?? null])),
  };
}

const answeredTree = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const yearSteps = (pointers = {}) => [
  { id: 'plan', label: 'Plan the year', prerequisites: [] },
  { id: 'sail', label: 'Learn to sail', prerequisites: ['plan'], ...(pointers.sail ? { opens: pointers.sail } : {}) },
  { id: 'book', label: 'Write the book', prerequisites: ['plan'], ...(pointers.book ? { opens: pointers.book } : {}) },
];
const yearAnswer = (opens) => answeredTree({ data: { id: 't_year', title: 'My year', nodes: yearSteps({ sail: 't_sail' }) }, mine: true, opens });
const SAIL_DONE = { treeId: 't_sail', title: 'Learn to sail', state: 'complete', done: 8, total: 8, loop: false };
const BOOK_OPEN = { treeId: 't_book', title: 'The book', state: 'open', done: 1, total: 4, loop: false };

test('the load’s facts stand over the device’s older copy until the session joins the server, and a pointer set since has the roadmap read once more', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = await ownerRoom(t, { treeAnswers: [yearAnswer({ sail: SAIL_DONE }), yearAnswer({ sail: SAIL_DONE, book: BOOK_OPEN })] });
  assert.deepEqual(room.faces(room.props.room.projectionRef.current), { plan: null, sail: 'complete', book: null });

  room.emit({ id: 't_year', title: 'My year', nodes: yearSteps() }, { joined: false });
  assert.deepEqual(room.faces(room.shown.at(-1)), { plan: null, sail: 'complete', book: null }, 'the device has not stored the pointer yet');

  const joined = { id: 't_year', title: 'My year', nodes: yearSteps({ sail: 't_sail', book: 't_book' }) };
  room.emit(joined, { joined: true });
  assert.deepEqual(room.faces(room.shown.at(-1)), { plan: null, sail: 'complete', book: 'unread' });
  assert.equal(room.reads.tree, 1);

  t.mock.timers.tick(599);
  assert.equal(room.reads.tree, 1);
  t.mock.timers.tick(1);
  await until(() => room.shown.length === 3);
  assert.deepEqual(room.faces(room.shown.at(-1)), { plan: null, sail: 'complete', book: 'open' });

  room.emit(joined, { joined: true });
  t.mock.timers.tick(600);
  await settle();
  assert.equal(room.reads.tree, 2);
  assert.deepEqual(globalThis.roomLoadIssues, []);
});

test('a read for a new pointer that fails is not asked again for the same pointers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = await ownerRoom(t, { treeAnswers: [yearAnswer({ sail: SAIL_DONE }), answeredTree({ code: 'opens-unavailable' }, 503)] });
  const joined = { id: 't_year', title: 'My year', nodes: yearSteps({ sail: 't_sail', book: 't_book' }) };

  room.emit(joined, { joined: true });
  t.mock.timers.tick(600);
  await until(() => room.reads.tree === 2);
  await settle();
  room.emit(joined, { joined: true });
  t.mock.timers.tick(600);
  await settle();

  assert.equal(room.reads.tree, 2);
  assert.deepEqual(room.faces(room.shown.at(-1)), { plan: null, sail: 'complete', book: 'unread' });
  assert.deepEqual(globalThis.roomLoadIssues.map(({ operation }) => operation), ['roadmap-opens-load']);
});

test('a tree chosen here stands at once over the load, as the picker knew it; it is read once the server confirms it, and again on the next confirmation after a read that failed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const room = await ownerRoom(t, { treeAnswers: [yearAnswer({ sail: SAIL_DONE }), answeredTree({ code: 'opens-unavailable' }, 503), yearAnswer({ sail: SAIL_DONE, book: BOOK_OPEN })] });
  const own = new Set(['book']);
  t.mock.method(SyncSession.prototype, 'ownPointers', () => own);
  const session = room.session();
  const book = (projection) => {
    const opening = projection.nodes.find((step) => step.id === 'book').opening;
    return opening ? { face: opening.face, provisional: opening.provisional, done: opening.done, total: opening.total } : null;
  };
  const attached = { id: 't_year', title: 'My year', nodes: yearSteps({ sail: 't_sail', book: 't_book' }) };

  room.view.tree.knowTree('book', { id: 't_book', title: 'The book', done: 0, total: 4 });
  room.emit(attached, { joined: false });
  assert.deepEqual(book(room.shown.at(-1)), { face: 'open', provisional: true, done: 0, total: 4 }, 'written here before the join: over the load');
  room.emit(attached, { joined: true });
  t.mock.timers.tick(600);
  await settle();
  assert.equal(room.reads.tree, 1, 'not read while the server has not confirmed it');

  own.clear();
  session.confirmations = 1;
  session.confirmedHandler();
  t.mock.timers.tick(600);
  await until(() => room.reads.tree === 2);
  await settle();
  assert.deepEqual(book(room.shown.at(-1)), { face: 'open', provisional: true, done: 0, total: 4 }, 'a read that failed leaves the row as the picker knew it');

  room.emit(attached, { joined: true });
  t.mock.timers.tick(600);
  await settle();
  assert.equal(room.reads.tree, 2, 'never in a loop: the same round asks nothing');

  session.confirmations = 2;
  session.confirmedHandler();
  t.mock.timers.tick(600);
  await until(() => room.reads.tree === 3);
  await until(() => book(room.shown.at(-1)).provisional === false);
  assert.deepEqual(book(room.shown.at(-1)), { face: 'open', provisional: false, done: 1, total: 4 });
  assert.deepEqual(globalThis.roomLoadIssues.map(({ operation }) => operation), ['roadmap-opens-load']);
});

test('without a pointer of its own unconfirmed, the room shows the load’s word before the join, as before', async (t) => {
  const room = await ownerRoom(t, { treeAnswers: [yearAnswer({ sail: SAIL_DONE })] });
  room.view.tree.knowTree('book', { id: 't_book', title: 'The book', done: 0, total: 4 });
  room.emit({ id: 't_year', title: 'My year', nodes: yearSteps({ sail: 't_sail', book: 't_book' }) }, { joined: false });
  assert.deepEqual(room.faces(room.shown.at(-1)), { plan: null, sail: 'complete', book: null });
});

test('a load that read nothing of the trees its steps open leaves the return ledger as it was, so the next visit recaps nothing done long before', async (t) => {
  const stored = { frame: { nodes: [
    { id: 'plan', createdAt: '1:0:srv', label: 'Plan the year', labelAt: '1:0:srv' },
    { id: 'sail', createdAt: '1:0:srv', label: 'Learn to sail', labelAt: '1:0:srv', opens: 't_sail', opensAt: '2:0:srv' },
  ], edges: [{ from: 'plan', to: 'sail', addedAt: '1:0:srv' }], kinds: [] }, lastSeq: 3 };
  const ledger = { completed: ['plan', 'sail'], at: 1 };
  const room = await ownerRoom(t, { treeAnswers: [answeredTree({ code: 'opens-unavailable' }, 503), yearAnswer({ sail: SAIL_DONE })], stored, ledger });
  assert.deepEqual(room.faces(room.props.room.projectionRef.current), { plan: null, sail: 'unread' });
  assert.deepEqual(JSON.parse(room.storage.getItem('windmill:return:t_year')), ledger);

  room.view.tree.retryLoad();
  await until(() => room.view.tree.reloadKey === 1 && !room.view.tree.loading && room.reads.tree === 2);

  assert.deepEqual(room.faces(room.props.room.projectionRef.current), { plan: null, sail: 'complete', book: null });
  assert.deepEqual(room.recaps, []);
  assert.deepEqual(JSON.parse(room.storage.getItem('windmill:return:t_year')).completed, ['plan', 'sail']);
});

test('a tree that lives only on this device opens on the marks its record holds, has its facts worked out on the device as the room opens, and again once a pointer changes', async (t) => {
  globalThis.roomLoadIssues = [];
  t.after(() => { delete globalThis.roomLoadIssues; });
  const disk = new Map([['windmill:device-trees', JSON.stringify({
    t_draft: { title: 'A draft', updatedAt: 4, claimed: false, owner: null },
    t_sail: { title: 'Learn to sail', updatedAt: 3, claimed: false, owner: null },
    t_book: { title: 'The book', updatedAt: 2, claimed: false, owner: null },
    t_kept: { title: 'On the server', updatedAt: 1, claimed: true, owner: null },
  })]]);
  const storage = { getItem: (key) => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value) };
  for (const [key, value] of Object.entries({ window: { location: { search: '', hash: '#/app/t_draft' }, localStorage: storage }, localStorage: storage })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  const step = (id, opens) => ({ id, createdAt: '1:0:device', label: id, labelAt: '1:0:device', ...(opens ? { opens, opensAt: '1:0:device' } : {}) });
  const records = {
    t_draft: { frame: { nodes: [step('plan'), step('sail', 't_sail'), step('again', 't_draft'), step('far', 't_kept')], edges: [], kinds: [] },
      progress: { marks: [{ node: 'plan', status: 'complete', at: '2:0:device', markedAt: 2 }] } },
    t_sail: { frame: { nodes: [step('rig'), step('wind')], edges: [], kinds: [] }, progress: { marks: [{ node: 'rig', status: 'complete', at: '2:0:device' }] } },
    t_book: { frame: { nodes: [], edges: [], kinds: [] } },
    t_kept: { frame: { nodes: [step('kept')], edges: [], kinds: [] } },
  };
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url.replace(/^.*\/v1/, '/v1'));
    return { ok: false, status: 401, json: async () => ({}) };
  });
  const stored = t.mock.method(SyncStore.prototype, 'load', async (treeId) => structuredClone(records[treeId] ?? null));
  t.mock.method(SyncStore.prototype, 'treeIds', async () => Object.keys(records));
  const sessions = [];
  t.mock.method(SyncSession.prototype, 'start', function () { sessions.push(this); return this; });
  t.mock.method(SyncSession.prototype, 'close', () => {});
  const shown = [];
  const props = roomProps('t_draft');
  const adopted = [];
  props.progressActs.adoptLoaded = (overlay) => adopted.push(overlay);
  props.structure.onTreeChanged = (projection) => shown.push(projection);
  props.structure.layoutPositions = (tree) => new Map(tree.nodes.map((node) => [node.id, { x: 0, y: 0 }]));
  const facts = (projection) => Object.fromEntries(projection.nodes.flatMap((node) => (node.opening
    ? [[node.id, { face: node.opening.face, title: node.opening.title, done: node.opening.done, total: node.opening.total, own: node.opening.own }]] : [])));

  const view = renderHook(t, () => captured.useRoomLoad({ ...props, accountId: null }));
  await until(() => !view.tree.loading);

  assert.deepEqual(facts(props.room.projectionRef.current), {
    sail: { face: 'open', title: 'Learn to sail', done: 1, total: 2, own: false },
    again: { face: 'loop', title: 'A draft', done: 1, total: 4, own: true },
    far: { face: 'missing', title: '', done: 0, total: 0, own: false },
  });
  assert.deepEqual(adopted, [{ completed: new Set(['plan']), completedAt: { plan: 2 } }], 'the room opens on the marks its session restores');
  const reads = stored.mock.callCount();
  sessions.at(-1).treeHandler({ id: 't_draft', title: 'A draft', nodes: [step('plan'), step('sail', 't_sail'), step('again', 't_draft'), step('far', 't_kept')]
    .map(({ id, opens }) => ({ id, label: id, prerequisites: [], ...(opens ? { opens } : {}) })) });
  assert.equal(stored.mock.callCount(), reads, 'the same pointers ask the device nothing');
  assert.deepEqual([...sessions.at(-1).leadNowhere], [['far', 't_kept']], 'the session owes the mark of a step whose pointer leads nowhere');

  sessions.at(-1).treeHandler({ id: 't_draft', title: 'A draft', nodes: [
    { id: 'plan', label: 'plan', prerequisites: [], opens: 't_book' },
    { id: 'sail', label: 'sail', prerequisites: [], opens: 't_sail' },
  ] });
  await until(() => shown.length === 3);
  assert.deepEqual(facts(shown.at(-1)), {
    plan: { face: 'empty', title: 'The book', done: 0, total: 0, own: false },
    sail: { face: 'open', title: 'Learn to sail', done: 1, total: 2, own: false },
  });
  assert.deepEqual(urls.filter((url) => url.startsWith('/v1/trees/')), ['/v1/trees/t_draft', '/v1/trees/t_draft/activity?since=0&limit=200'],
    'the load\'s own tree and activity, its marks from the device, and nothing after');
  assert.deepEqual(globalThis.roomLoadIssues, []);
});
