import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncSession } from '../../../../src/products/roadmap/sync/SyncSession.js';

function sessionWith({ notify = () => {}, registry = null, save = () => Promise.resolve(), reportFailure = () => {}, Session = SyncSession } = {}) {
  const session = new Session({ treeId: 'tree', registry, store: { save }, reportFailure });
  session.seed({ id: 'tree', title: 'Tree', nodes: [{ id: 'root', label: 'Root', prerequisites: [] }] });
  session.onTreeChanged(notify);
  return session;
}

const snapshot = (session) => session.lattice.toTreeData().nodes.map(({ id, label, prerequisites }) => ({ id, label, prerequisites }));

test('dispatch returns null before ready and for gestures writing nothing', () => {
  const session = new SyncSession({ treeId: 'tree', registry: null });
  assert.equal(session.dispatch({ kind: 'CreateNode', id: 'x' }), null);
  assert.equal(session.revert({}), false);
  assert.deepEqual(session.undoStack, []);
  session.ready = true;
  assert.equal(session.dispatch({ kind: 'DeleteNode', id: 'absent' }), null);
  assert.deepEqual(session.undoStack, []);
});

test('a receipt reverts its own create once without undoing a newer gesture', () => {
  const session = sessionWith();
  const created = session.dispatch({ kind: 'CreateNode', id: 'child', label: 'Child', prerequisites: ['root'] });
  const renamed = session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Renamed root' });
  assert.ok(Object.isFrozen(created));
  assert.equal(session.revert(created), true);
  assert.deepEqual(snapshot(session), [{ id: 'root', label: 'Renamed root', prerequisites: [] }]);
  assert.equal(session.revert(created), false);
  assert.equal(session.revert(null), false);
  assert.equal(session.undoStack.length, 1);
  assert.equal(session.revert(renamed), true);
  assert.deepEqual(snapshot(session), [{ id: 'root', label: 'Root', prerequisites: [] }]);
  assert.deepEqual(session.undoStack, []);
  assert.deepEqual(session.redoStack, []);
});

test('a receipt is session-bound and a global Undo consumes its authority', () => {
  const session = sessionWith();
  const other = sessionWith();
  const receipt = session.dispatch({ kind: 'SetNodeColor', id: 'root', color: 'sky' });
  assert.equal(other.revert(receipt), false);
  session.undo();
  assert.equal(session.revert(receipt), false);
  session.redo();
  assert.equal(session.revert(receipt), false);
  assert.equal(session.lattice.toTreeData().nodes[0].color, 'sky');
});

test('revert restamps only the captured fields and preserves an unrelated later edit', () => {
  const session = sessionWith();
  const receipt = session.dispatch({ kind: 'SetNodeColor', id: 'root', color: 'sky' });
  session.dispatch({ kind: 'DescribeNode', id: 'root', description: 'Later description' });
  assert.equal(session.revert(receipt), true);
  const step = session.lattice.toTreeData().nodes[0];
  assert.deepEqual({ color: step.color, description: step.description }, { color: 'terracotta', description: 'Later description' });
  assert.equal(session.undoStack.length, 1);
});

test('a pre-apply refusal preserves the undo journal and leaves no node', () => {
  const session = sessionWith();
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Renamed' });
  session.undo();
  const redo = [...session.redoStack];
  assert.throws(() => session.dispatch({ kind: 'CreateNode', id: null, prerequisites: [] }), { message: 'malformed node entry' });
  assert.deepEqual(session.undoStack, []);
  assert.deepEqual(session.redoStack, redo);
  assert.deepEqual(snapshot(session), [{ id: 'root', label: 'Root', prerequisites: [] }]);
});

test('applied writes keep their receipt and report real errors at each failed boundary', () => {
  const failures = [];
  const notifyError = new Error('private notification');
  const storageError = new Error('private storage');
  const transportError = new Error('private transport');
  class FailingTransportSession extends SyncSession {
    send() { throw transportError; }
  }
  const session = sessionWith({
    Session: FailingTransportSession,
    notify: () => { throw notifyError; },
    registry: { touch: () => { throw storageError; } },
    reportFailure: (operation, error) => failures.push({ operation, error }),
  });
  session.phase = 'live';
  const receipt = session.dispatch({ kind: 'CreateNode', id: 'child', label: 'Child', prerequisites: ['root'] });
  assert.ok(receipt);
  assert.deepEqual(snapshot(session), [{ id: 'root', label: 'Root', prerequisites: [] }, { id: 'child', label: 'Child', prerequisites: ['root'] }]);
  assert.deepEqual(failures, [
    { operation: 'roadmap-sync-notify', error: notifyError },
    { operation: 'roadmap-sync-persist', error: storageError },
    { operation: 'roadmap-sync-send', error: transportError },
  ]);
  assert.equal(session.durabilityAtRisk, true);
  assert.equal(session.revert(receipt), true);
});

test('asynchronous persistence failure retains its real error after dispatch succeeded', async () => {
  const failures = [];
  const storageError = new Error('private storage');
  const session = sessionWith({
    save: () => Promise.reject(storageError),
    reportFailure: (operation, error) => failures.push({ operation, error }),
  });
  const receipt = session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Renamed' });
  await Promise.resolve();
  assert.ok(receipt);
  assert.deepEqual(failures, [{ operation: 'roadmap-sync-persist', error: storageError }]);
  assert.equal(session.durabilityAtRisk, true);
});

for (const action of ['dispatch', 'revert', 'undo', 'redo', 'renameTree']) {
  for (const boundary of ['status', 'notify', 'persist', 'save', 'send']) {
    test(`${action} contains ${boundary} failure after applying and retains its undo journal`, async () => {
      const failure = new Error('private boundary failure');
      const reports = [];
      let fail = false;
      class BoundarySession extends SyncSession {
        emitStatus() {
          if (fail && boundary === 'status') throw failure;
          super.emitStatus();
        }
        send() {
          if (fail && boundary === 'send') throw failure;
        }
      }
      const session = sessionWith({
        Session: BoundarySession,
        notify: () => { if (fail && boundary === 'notify') throw failure; },
        registry: { touch: () => { if (fail && boundary === 'persist') throw failure; } },
        save: () => fail && boundary === 'save' ? Promise.reject(failure) : Promise.resolve(),
        reportFailure: (operation, error) => reports.push({ operation, error }),
      });
      session.phase = 'live';
      let receipt;
      if (['revert', 'undo', 'redo'].includes(action)) {
        receipt = session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Renamed' });
      }
      if (action === 'redo') session.undo();
      fail = true;
      let result;
      assert.doesNotThrow(() => {
        if (action === 'dispatch') result = session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Renamed' });
        if (action === 'revert') result = session.revert(receipt);
        if (action === 'undo') session.undo();
        if (action === 'redo') session.redo();
        if (action === 'renameTree') result = session.renameTree('New title');
      });
      await Promise.resolve();
      const operation = boundary === 'status' || boundary === 'notify' ? 'notify' : boundary === 'send' ? 'send' : 'persist';
      assert.deepEqual(reports, [{ operation: `roadmap-sync-${operation}`, error: failure }]);
      assert.equal(session.durabilityAtRisk, operation !== 'notify');
      assert.deepEqual(snapshot(session), [{ id: 'root', label: ['dispatch', 'redo'].includes(action) ? 'Renamed' : 'Root', prerequisites: [] }]);
      assert.deepEqual([session.undoStack.length, session.redoStack.length], {
        dispatch: [1, 0], revert: [0, 0], undo: [0, 1], redo: [1, 0], renameTree: [0, 0],
      }[action]);
      assert.deepEqual({ structure: session.statusSnapshot().structureGestures, progress: session.statusSnapshot().progressGestures }, {
        structure: { dispatch: 1, revert: 2, undo: 2, redo: 3, renameTree: 1 }[action], progress: 0,
      });
      if (action === 'dispatch') assert.equal(Object.isFrozen(result), true);
      if (action === 'revert' || action === 'renameTree') assert.equal(result, true);
      if (action === 'renameTree') assert.equal(session.lattice.title, 'New title');
    });
  }
}

for (const kind of ['DeleteNode', 'BulkDelete']) {
  test(`${kind} global Undo restores every retired incident edge and node`, () => {
    const session = sessionWith();
    session.dispatch({ kind: 'CreateNode', id: 'middle', label: 'Middle', parentId: 'root' });
    session.dispatch({ kind: 'CreateNode', id: 'child', label: 'Child', parentId: 'middle' });
    const before = session.lattice.toTreeData();
    const beforeEdges = session.lattice.presentEdges();
    session.dispatch(kind === 'DeleteNode' ? { kind, id: 'middle' } : { kind, nodeIds: ['middle'] });
    assert.deepEqual(session.lattice.presentEdges(), [{ from: 'root', to: 'child' }]);
    assert.deepEqual(session.maskedWork(), []);
    session.undo();
    const restored = session.lattice.toTreeData();
    assert.deepEqual(restored.nodes.map(({ createdAt, createdMs, ...node }) => node), before.nodes.map(({ createdAt, createdMs, ...node }) => node));
    assert.deepEqual({ id: restored.id, title: restored.title, kinds: restored.kinds }, { id: before.id, title: before.title, kinds: before.kinds });
    assert.deepEqual(session.lattice.presentEdges(), beforeEdges);
    session.redo();
    assert.deepEqual(session.lattice.presentEdges(), [{ from: 'root', to: 'child' }]);
    assert.deepEqual(session.maskedWork(), []);
  });
}

class TestSocket extends EventTarget {
  static OPEN = 1;
  static sockets = [];
  constructor() {
    super();
    this.readyState = 0;
    this.frames = [];
    TestSocket.sockets.push(this);
  }
  send(text) { this.frames.push(JSON.parse(text)); }
  open() { this.readyState = TestSocket.OPEN; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  message(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
}

function connectedSession(t, overrides = {}) {
  t.mock.method(globalThis, 'setInterval', () => 0);
  t.mock.method(globalThis, 'clearInterval', () => {});
  const priorSocket = globalThis.WebSocket;
  const priorWindow = globalThis.window;
  globalThis.WebSocket = TestSocket;
  globalThis.window = new EventTarget();
  t.after(() => { globalThis.WebSocket = priorSocket; globalThis.window = priorWindow; });
  const saves = [];
  const store = {
    save: async (treeId, value) => { saves.push(structuredClone(value)); },
    replaceLane: async (treeId, lane, epoch) => {
      const value = structuredClone(saves.at(-1));
      value.epochs[lane] = epoch + 1;
      if (lane === 'structure') { value.frame = value.confirmed.structure; value.lastSeq = 0; }
      else value.progress = value.confirmed.progress;
      saves.push(value);
      return { status: 'replaced', value };
    },
    ...overrides,
  };
  const session = new SyncSession({ treeId: 'tree', store, registry: null });
  t.after(() => session.close());
  session.connect();
  session.ws.open();
  session.receiveState({ t: 'subgraph', intent: 'delta', seq: 1,
    nodes: [{ id: 'root', createdAt: '1:0:server', label: 'Root', labelAt: '1:0:server' }], edges: [], kinds: [] });
  session.receiveProgressGraft({ marks: [] });
  return { session, saves, store };
}

function refuseLast(session, lane, code = 'bad-frame') {
  const map = lane === 'structure' ? session.inFlight : session.progressInFlight;
  const frameId = [...map.keys()].at(-1);
  assert.ok(frameId);
  session.receiveReject({ t: 'reject', frameId, code });
  return frameId;
}

test('status snapshots are frozen, stable and cover both lanes, socket transitions and acknowledgements', (t) => {
  const { session } = connectedSession(t);
  const seen = [];
  const stop = session.subscribeStatus((value) => seen.push(value));
  assert.deepEqual(seen, [{ phase: 'live', online: true, structurePending: 0, progressPending: 0,
    structureInFlight: 0, progressInFlight: 0, structureGestures: 0, progressGestures: 0, rebaselining: false, refused: null, receiptVersion: 0 }]);
  assert.equal(session.statusSnapshot(), seen[0]);
  assert.equal(Object.isFrozen(seen[0]), true);
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Local' });
  assert.deepEqual(seen.at(-1), { ...seen[0], structurePending: 1, structureInFlight: 1, structureGestures: 1 });
  session.markProgress('root', 'complete');
  assert.deepEqual(seen.at(-1), { ...seen[0], structurePending: 1, progressPending: 1, structureInFlight: 1, progressInFlight: 1, structureGestures: 1, progressGestures: 1 });
  session.receiveAck({ frameId: [...session.inFlight.keys()][0] });
  assert.deepEqual(seen.at(-1), { ...seen[0], progressPending: 1, progressInFlight: 1, progressGestures: 1 });
  session.receiveProgressAck({ frameId: [...session.progressInFlight.keys()][0] });
  assert.deepEqual(seen.at(-1), seen[0]);
  session.ws.close();
  assert.deepEqual(seen.at(-1), { ...seen[0], phase: 'offline' });
  session.connect();
  session.ws.open();
  assert.deepEqual(seen.at(-1), { ...seen[0], phase: 'syncing' });
  stop();
  const count = seen.length;
  session.close();
  assert.equal(seen.length, count);
});

test('refusals retain both lanes, exclude ownership/session codes, and clear at lane drain', (t) => {
  const { session } = connectedSession(t);
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Local' });
  refuseLast(session, 'structure', 'tree-too-large');
  const structure = session.statusSnapshot().refused;
  assert.equal(Object.isFrozen(structure), true);
  assert.deepEqual({ lane: structure.lane, code: structure.code }, { lane: 'structure', code: 'tree-too-large' });
  session.markProgress('root', 'complete');
  refuseLast(session, 'progress', 'server-error');
  session.receiveState({ ...session.lattice.toFrame(), seq: 2 });
  assert.deepEqual({ lane: session.statusSnapshot().refused.lane, code: session.statusSnapshot().refused.code }, { lane: 'progress', code: 'server-error' });
  session.receiveProgressGraft(session.progress.toFrame());
  assert.equal(session.statusSnapshot().refused, null);
  for (const code of ['not-yours', 'nobodys-tree', 'sign-in-required']) {
    session.dispatch({ kind: 'RenameNode', id: 'root', label: code });
    refuseLast(session, 'structure', code);
    assert.equal(session.statusSnapshot().refused, null);
  }
});

test('retry uses reconnect and graft flush and preserves the refusal episode for the same bank', (t) => {
  const { session } = connectedSession(t);
  const serverFrame = session.lattice.toFrame();
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Local' });
  refuseLast(session, 'structure');
  const episode = session.statusSnapshot().refused.episode;
  session.retry();
  assert.equal(session.statusSnapshot().refused, null);
  assert.equal(session.phase, 'offline');
  assert.ok(session.reconnectTimer);
  session.connect();
  session.ws.open();
  session.receiveState({ ...serverFrame, seq: 1 });
  assert.equal(session.ws.frames.at(-1).intent, 'flush');
  refuseLast(session, 'structure');
  assert.equal(session.statusSnapshot().refused.episode, episode);
});

test('structure discard immediately restores confirmed projection, preserves progress, and invalidates receipts', async (t) => {
  const { session, saves } = connectedSession(t);
  const server = session.lattice.toFrame();
  const projections = [];
  session.onTreeChanged((value) => projections.push(value.nodes.map((node) => node.label)));
  const receipt = session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Local' });
  session.markProgress('root', 'complete');
  const progress = session.progress.toFrame();
  refuseLast(session, 'structure');
  assert.equal(await session.discard(), true);
  assert.deepEqual(session.lattice.toFrame(), server);
  assert.deepEqual(session.progress.toFrame(), progress);
  assert.deepEqual(saves.at(-1).progress, progress);
  assert.deepEqual(saves.at(-1).frame, server);
  assert.deepEqual(session.undoStack, []);
  assert.deepEqual(session.redoStack, []);
  assert.equal(session.revert(receipt), false);
  assert.equal(session.statusSnapshot().receiptVersion, 1);
  assert.equal(session.dispatch({ kind: 'CreateNode', id: 'blocked' }), null);
  assert.deepEqual(projections, [['Local'], ['Root'], ['Root']]);
  session.connect();
  session.ws.open();
  assert.deepEqual(session.ws.frames[0], { t: 'subscribe', treeId: 'tree', lastSeq: 0, vector: {} });
  session.receiveState({ ...server, seq: 1 });
  assert.deepEqual(projections, [['Local'], ['Root'], ['Root'], ['Root']]);
  assert.equal(session.ready, true);
  assert.deepEqual(session.progress.toFrame(), progress);
});

test('progress discard preserves structure and its outbox until a fresh progress graft arrives', async (t) => {
  const { session, saves } = connectedSession(t);
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Local' });
  const structure = session.lattice.toFrame();
  session.markProgress('root', 'complete');
  const overlays = [];
  session.onProgress((value) => overlays.push([...value.completed]));
  refuseLast(session, 'progress');
  assert.equal(await session.discard(), true);
  assert.deepEqual(saves.at(-1).frame, structure);
  assert.deepEqual(saves.at(-1).progress, { marks: [] });
  assert.deepEqual(session.lattice.toFrame(), structure);
  assert.equal(session.pendingEditCount(), 1);
  assert.deepEqual(overlays, [[], []]);
  assert.equal(session.ready, false);
  session.receiveState({ nodes: [], edges: [], kinds: [], seq: 1 });
  assert.equal(session.ready, false);
  session.receiveProgressGraft({ marks: [] });
  assert.equal(session.ready, true);
  assert.deepEqual(overlays, [[], [], []]);
});

test('discard quiesces structure writes and defers preserved-lane progress persistence while replacement awaits', async (t) => {
  let finish;
  const { session, saves } = connectedSession(t, { replaceLane: () => new Promise((resolve) => { finish = resolve; }) });
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Local' });
  refuseLast(session, 'structure');
  session.scheduleSave();
  const previous = session.lattice.toFrame();
  const socket = session.ws;
  const discarding = session.discard();
  assert.equal(session.saveTimer, null);
  const count = saves.length;
  await session.persistNow();
  socket.message({ t: 'subgraph', intent: 'delta', seq: 9, nodes: [{ id: 'late', createdAt: '999:0:server' }] });
  session.markProgress('root', 'complete');
  session.renameTree('No write');
  session.undo();
  session.flush();
  assert.equal(session.dispatch({ kind: 'RenameNode', id: 'root', label: 'No write' }), null);
  assert.deepEqual(session.lattice.toFrame(), previous);
  const progress = session.progress.toFrame();
  assert.equal(progress.marks[0].status, 'complete');
  assert.equal(saves.length, count);
  const replacement = structuredClone(saves.at(-1));
  replacement.epochs.structure += 1;
  replacement.frame = replacement.confirmed.structure;
  replacement.lastSeq = 0;
  finish({ status: 'replaced', value: replacement });
  assert.equal(await discarding, true);
  assert.deepEqual(saves.at(-1).progress, progress);
  session.connect();
  session.ws.open();
  socket.message({ t: 'subgraph', intent: 'delta', seq: 9, ...previous });
  assert.deepEqual(session.lattice.toFrame(), replacement.frame);
});

test('failed discard restores the refusal, preserves receipts and reports one real-stack boundary failure', async (t) => {
  const error = new Error('private storage failure');
  const { session } = connectedSession(t, { replaceLane: async () => { throw error; } });
  const reports = [];
  session.reportFailure = (operation, failure) => reports.push({ operation, failure });
  const receipt = session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Local' });
  refuseLast(session, 'structure');
  const refused = session.statusSnapshot().refused;
  assert.equal(await session.discard(), false);
  assert.equal(session.statusSnapshot().refused, refused);
  assert.equal(session.statusSnapshot().receiptVersion, 0);
  assert.equal(session.ready, true);
  assert.deepEqual(reports, [{ operation: 'roadmap-sync-discard', failure: error }]);
  assert.ok(reports[0].failure.stack);
  assert.equal(session.revert(receipt), true);
});

test('browser online changes publish immediately and listeners leave with the session', async (t) => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const priorSocket = globalThis.WebSocket;
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  globalThis.WebSocket = TestSocket;
  t.after(() => { globalThis.window = priorWindow; globalThis.document = priorDocument; globalThis.WebSocket = priorSocket; });
  const session = new SyncSession({ treeId: 'tree', registry: null,
    store: { load: async () => null, requestPersistent: async () => true, save: async () => {} } });
  t.after(() => session.close());
  const snapshots = [];
  session.subscribeStatus((value) => snapshots.push(value));
  await session.start();
  window.dispatchEvent(new Event('offline'));
  assert.equal(snapshots.at(-1).online, false);
  window.dispatchEvent(new Event('online'));
  assert.equal(snapshots.at(-1).online, true);
  session.close();
  const count = snapshots.length;
  window.dispatchEvent(new Event('offline'));
  assert.equal(snapshots.length, count);
});

test('legacy refusal signals and warnings remain unchanged without a status subscriber', (t) => {
  const { session } = connectedSession(t);
  const forbidden = [];
  const warnings = [];
  window.addEventListener('wm-edit-forbidden', (event) => forbidden.push(event.detail));
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const capacity = { t: 'reject', frameId: 'legacy-frame', code: 'tree-too-large', reason: 'private sentence' };
  const auth = { t: 'reject', code: 'sign-in-required' };
  const other = { t: 'reject', code: 'server-error', reason: 'private sentence' };
  session.receiveReject(capacity);
  session.receiveReject(auth);
  session.receiveReject(other);
  assert.deepEqual(forbidden, [capacity, auth]);
  assert.deepEqual(warnings, [['[sync] frame rejected —', 'server-error', 'private sentence']]);
  assert.equal(session.durabilityAtRisk, true);
  assert.equal(session.statusSnapshot().refused, null);
});

test('a delayed socket close after durable discard leaves exactly one reconnect', async (t) => {
  const { session } = connectedSession(t);
  const timers = new Map();
  let nextTimer = 0;
  t.mock.method(globalThis, 'setTimeout', (run) => {
    const id = ++nextTimer;
    timers.set(id, run);
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', (id) => timers.delete(id));
  const socket = session.ws;
  t.mock.method(socket, 'close', () => { socket.readyState = 3; });
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Local' });
  refuseLast(session, 'structure');
  assert.equal(await session.discard(), true);
  assert.equal(timers.size, 1);
  const firstTimer = session.reconnectTimer;
  socket.dispatchEvent(new Event('close'));
  assert.equal(timers.has(firstTimer), false);
  assert.equal(timers.size, 1);
  const reconnect = timers.get(session.reconnectTimer);
  timers.delete(session.reconnectTimer);
  reconnect();
  assert.notEqual(session.ws, socket);
  const replacement = session.ws;
  socket.dispatchEvent(new Event('close'));
  assert.equal(session.ws, replacement);
  assert.equal(timers.size, 0);
});

test('start refreshes browser connectivity after an asynchronous local load', async (t) => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const priorSocket = globalThis.WebSocket;
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  globalThis.WebSocket = TestSocket;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  t.after(() => {
    globalThis.window = priorWindow;
    globalThis.document = priorDocument;
    globalThis.WebSocket = priorSocket;
    if (priorNavigator) Object.defineProperty(globalThis, 'navigator', priorNavigator);
    else delete globalThis.navigator;
  });
  let load;
  const session = new SyncSession({ treeId: 'tree', registry: null,
    store: { load: () => new Promise((resolve) => { load = resolve; }), requestPersistent: async () => true, save: async () => {} } });
  t.after(() => session.close());
  const started = session.start();
  navigator.onLine = false;
  window.dispatchEvent(new Event('offline'));
  load(null);
  await started;
  assert.equal(session.statusSnapshot().online, false);
});

test('status reads are pure and an unobserved local edit performs no pending-delta scans', (t) => {
  const { session } = connectedSession(t);
  const reads = [];
  const delta = session.lattice.deltaSince.bind(session.lattice);
  t.mock.method(session.lattice, 'deltaSince', (vector) => {
    if (vector != null) reads.push(vector);
    return delta(vector);
  });
  session.phase = 'offline';
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Quiet edit' });
  assert.deepEqual(reads, []);
  const refusal = Object.freeze({ lane: 'progress', code: 'server-error' });
  session.refusals.set('progress', refusal);
  const cache = session.status;
  const state = session.statusSnapshot();
  assert.equal(state.refused, refusal);
  assert.equal(session.refusals.get('progress'), refusal);
  assert.equal(session.status, cache);
  session.noteDrained();
  assert.equal(session.refusals.has('progress'), false);
});

test('reject and socket close clear progress in-flight state without dropping its pending marks', (t) => {
  const { session } = connectedSession(t);
  session.markProgress('root', 'complete');
  const pending = session.progress.toFrame();
  const frameId = [...session.progressInFlight.keys()][0];
  session.receiveReject({ t: 'reject', frameId, code: 'server-error' });
  assert.equal(session.progressInFlight.size, 0);
  assert.deepEqual(session.progress.toFrame(), pending);
  session.flushProgress();
  assert.equal(session.progressInFlight.size, 1);
  session.ws.close();
  assert.equal(session.progressInFlight.size, 0);
  assert.equal(session.phase, 'offline');
  assert.deepEqual(session.progress.toFrame(), pending);
});

test('stale socket open, message and close events cannot change a replacement connection', (t) => {
  const { session } = connectedSession(t);
  const old = session.ws;
  session.connect();
  const current = session.ws;
  current.open();
  const before = session.lattice.toFrame();
  old.open();
  old.message({ t: 'subgraph', intent: 'delta', seq: 99, nodes: [{ id: 'stale', createdAt: '99:0:server' }] });
  old.close();
  assert.equal(session.ws, current);
  assert.equal(session.phase, 'syncing');
  assert.deepEqual(session.lattice.toFrame(), before);
  assert.deepEqual(current.frames, [{ t: 'subscribe', treeId: 'tree', lastSeq: 1, vector: { server: '1:0:server' } }]);
});

test('close publishes offline with empty in-flight maps while retaining the unacknowledged bank', (t) => {
  const { session } = connectedSession(t);
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Pending' });
  session.markProgress('root', 'complete');
  const states = [];
  session.subscribeStatus((state) => states.push(state));
  session.close();
  assert.deepEqual(states.at(-1), { phase: 'offline', online: true, structurePending: 1, progressPending: 1,
    structureInFlight: 0, progressInFlight: 0, structureGestures: 1, progressGestures: 1, rebaselining: false, refused: null, receiptVersion: 0 });
  assert.equal(session.statusHandlers.size, 0);
});

test('refusal-only subscribers add no full status computation or pending-delta scans to ordinary writes and acknowledgements', (t) => {
  const { session } = connectedSession(t);
  let snapshots = 0;
  let pendingReads = 0;
  let deltaReads = 0;
  const statusSnapshot = session.statusSnapshot.bind(session);
  const pendingEditCount = session.pendingEditCount.bind(session);
  const deltaSince = session.lattice.deltaSince.bind(session.lattice);
  t.mock.method(session, 'statusSnapshot', () => { snapshots += 1; return statusSnapshot(); });
  t.mock.method(session, 'pendingEditCount', () => { pendingReads += 1; return pendingEditCount(); });
  t.mock.method(session.lattice, 'deltaSince', (vector) => {
    if (vector != null) deltaReads += 1;
    return deltaSince(vector);
  });
  const seen = [];
  const unsubscribe = session.subscribeRefusals((refusal) => seen.push(refusal));
  assert.equal(session.statusHandlers.size, 0);
  assert.equal(session.refusalHandlers.size, 1);
  assert.deepEqual(seen, []);
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Local' });
  session.receiveAck({ frameId: [...session.inFlight.keys()][0] });
  session.markProgress('root', 'complete');
  session.receiveProgressAck({ frameId: [...session.progressInFlight.keys()][0] });
  session.receiveLive({ t: 'subgraph', seq: 2, nodes: [{ id: 'peer', createdAt: '999:0:peer' }], edges: [], kinds: [] });
  session.emitStatus();
  assert.deepEqual({ snapshots, pendingReads, deltaReads, seen }, { snapshots: 0, pendingReads: 0, deltaReads: 0, seen: [] });
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Refused' });
  refuseLast(session, 'structure');
  const refusal = session.refusals.get('structure');
  assert.deepEqual(seen, [refusal]);
  assert.equal(Object.isFrozen(refusal), true);
  assert.deepEqual({ snapshots, pendingReads, deltaReads }, { snapshots: 0, pendingReads: 0, deltaReads: 1 });
  assert.equal(session.statusHandlers.size, 0);
  unsubscribe();
  assert.equal(session.refusalHandlers.size, 0);
});

test('refusal-only subscriptions replay current lanes and stop at unsubscribe or session close', (t) => {
  const { session } = connectedSession(t);
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Local' });
  refuseLast(session, 'structure', 'tree-too-large');
  const structure = session.refusals.get('structure');
  const first = [];
  const unsubscribe = session.subscribeRefusals((refusal) => first.push(refusal));
  assert.deepEqual(first, [structure]);
  session.markProgress('root', 'complete');
  refuseLast(session, 'progress', 'server-error');
  const progress = session.refusals.get('progress');
  assert.deepEqual(first, [structure, progress]);
  unsubscribe();
  const second = [];
  session.subscribeRefusals((refusal) => second.push(refusal));
  assert.deepEqual(second, [structure, progress]);
  session.retry();
  assert.deepEqual(first, [structure, progress]);
  assert.deepEqual(second, [structure, progress]);
  assert.equal(session.refusalHandlers.size, 1);
  session.close();
  assert.equal(session.refusalHandlers.size, 0);
  assert.deepEqual(second, [structure, progress]);
});

test('refusal-only subscribers follow the existing refusal eligibility and add no auth or untracked reports', (t) => {
  const { session } = connectedSession(t);
  const seen = [];
  session.subscribeRefusals((refusal) => seen.push(refusal));
  t.mock.method(console, 'warn', () => {});
  for (const code of ['not-yours', 'nobodys-tree', 'sign-in-required']) {
    session.dispatch({ kind: 'RenameNode', id: 'root', label: code });
    refuseLast(session, 'structure', code);
  }
  session.receiveReject({ t: 'reject', frameId: 'untracked', code: 'server-error' });
  assert.deepEqual(seen, []);
  assert.equal(session.statusHandlers.size, 0);
});

test('a create with prerequisites is one pending gesture; retry, partial acknowledgements and discard preserve lane counts', async (t) => {
  const { session } = connectedSession(t);
  const server = session.lattice.toFrame();
  session.dispatch({ kind: 'CreateNode', id: 'child', label: 'Child', prerequisites: ['root'] });
  const createdFrame = [...session.inFlight.keys()].at(-1);
  assert.equal(session.statusSnapshot().structurePending, 2);
  assert.equal(session.statusSnapshot().structureGestures, 1);
  session.dispatch({ kind: 'RenameNode', id: 'child', label: 'First rename' });
  session.dispatch({ kind: 'RenameNode', id: 'child', label: 'Second rename' });
  assert.equal(session.statusSnapshot().structureGestures, 3);
  session.receiveAck({ frameId: createdFrame });
  assert.equal(session.statusSnapshot().structureGestures, 2);
  refuseLast(session, 'structure');
  session.markProgress('root', 'complete');
  session.markProgress('root', 'none');
  assert.equal(session.statusSnapshot().progressGestures, 2);
  session.retry();
  assert.equal(session.statusSnapshot().structureGestures, 2);
  session.connect();
  session.ws.open();
  session.receiveState({ ...server, seq: 1 });
  assert.equal(session.statusSnapshot().structureGestures, 2);
  refuseLast(session, 'structure');
  assert.equal(await session.discard(), true);
  assert.equal(session.statusSnapshot().structureGestures, 0);
  assert.equal(session.statusSnapshot().progressGestures, 2);
});

test('discard immediately projects the confirmed tree and suppresses transport work through a slow rebaseline', async (t) => {
  let finish;
  const { session, saves } = connectedSession(t, { replaceLane: () => new Promise((resolve) => { finish = resolve; }) });
  const confirmed = session.lattice.toFrame();
  const projected = [];
  session.onTreeChanged((tree) => projected.push(tree.nodes.map((node) => node.id)));
  session.dispatch({ kind: 'CreateNode', id: 'child', label: 'Child', prerequisites: ['root'] });
  refuseLast(session, 'structure');
  const discarding = session.discard();
  assert.deepEqual(projected, [['root', 'child'], ['root']]);
  const expected = { phase: 'syncing', online: true, structurePending: 0, progressPending: 0,
    structureInFlight: 0, progressInFlight: 0, structureGestures: 0, progressGestures: 0,
    rebaselining: true, refused: null, receiptVersion: 0 };
  assert.deepEqual(session.statusSnapshot(), expected);
  const value = structuredClone(saves.at(-1));
  value.epochs.structure += 1;
  value.frame = value.confirmed.structure;
  value.lastSeq = 0;
  finish({ status: 'replaced', value });
  assert.equal(await discarding, true);
  assert.deepEqual(session.statusSnapshot(), { ...expected, receiptVersion: 1 });
  session.connect();
  session.ws.open();
  assert.deepEqual(session.statusSnapshot(), { ...expected, receiptVersion: 1 });
  session.receiveState({ ...confirmed, seq: 1 });
  assert.deepEqual(session.statusSnapshot(), { ...expected, phase: 'live', rebaselining: false, receiptVersion: 1 });
});

test('failed discard restores the unconfirmed projection without losing the gesture count', async (t) => {
  let fail;
  const { session } = connectedSession(t, { replaceLane: () => new Promise((_resolve, reject) => { fail = reject; }) });
  const projected = [];
  session.onTreeChanged((tree) => projected.push(tree.nodes.map((node) => node.label)));
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Kept draft' });
  refuseLast(session, 'structure');
  const discarding = session.discard();
  assert.deepEqual(projected, [['Kept draft'], ['Root']]);
  fail(new Error('storage unavailable'));
  assert.equal(await discarding, false);
  assert.deepEqual(projected, [['Kept draft'], ['Root'], ['Kept draft']]);
  assert.equal(session.statusSnapshot().structureGestures, 1);
});

for (const lane of ['structure', 'progress']) {
  test(`${lane} discard finishes and reconnects when both immediate and durable projection notifications fail`, async (t) => {
    const { session, saves } = connectedSession(t);
    const errors = [];
    session.reportFailure = (operation, error) => errors.push({ operation, error });
    if (lane === 'structure') session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Refused' });
    else session.markProgress('root', 'complete');
    refuseLast(session, lane);
    const failure = new Error('private callback failure');
    if (lane === 'structure') session.onTreeChanged(() => { throw failure; });
    else session.onProgress(() => { throw failure; });
    assert.equal(await session.discard(), true);
    assert.equal(session.discardPending, false);
    assert.ok(session.reconnectTimer);
    assert.equal(session.epochs[lane], 1);
    assert.deepEqual(saves.at(-1)[lane === 'structure' ? 'frame' : 'progress'], saves.at(-1).confirmed[lane]);
    assert.deepEqual(errors, [
      { operation: 'roadmap-sync-notify', error: failure },
      { operation: 'roadmap-sync-notify', error: failure },
    ]);
    assert.ok(errors.every(({ error }) => error.stack));
  });
}

test('one bulk progress action counts as one gesture and acknowledges all its marks', (t) => {
  const { session } = connectedSession(t);
  session.markProgress(['root', 'child'], 'complete');
  assert.deepEqual({ pending: session.statusSnapshot().progressPending, gestures: session.statusSnapshot().progressGestures }, { pending: 2, gestures: 1 });
  const frame = session.ws.frames.at(-1);
  assert.deepEqual(frame.marks.map(({ node, status }) => ({ node, status })), [
    { node: 'child', status: 'complete' }, { node: 'root', status: 'complete' },
  ]);
  assert.equal(frame.marks[0].at, frame.marks[1].at);
  session.receiveProgressAck({ frameId: frame.frameId });
  assert.deepEqual({ pending: session.statusSnapshot().progressPending, gestures: session.statusSnapshot().progressGestures }, { pending: 0, gestures: 0 });
});

test('a lapsed roadmap session retains its write and gesture through same-account reconnect, then drains on acknowledgement', (t) => {
  const { session } = connectedSession(t);
  const server = session.lattice.toFrame();
  session.dispatch({ kind: 'CreateNode', id: 'child', label: 'Kept on device', prerequisites: ['root'] });
  const bank = session.lattice.toFrame();
  const legacySignals = [];
  window.addEventListener('wm-edit-forbidden', (event) => legacySignals.push(event.detail.code));
  refuseLast(session, 'structure', 'sign-in-required');
  assert.deepEqual(legacySignals, ['sign-in-required']);
  assert.deepEqual(session.lattice.toFrame(), bank);
  assert.equal(session.statusSnapshot().structureGestures, 1);
  assert.equal(session.statusSnapshot().refused, null);
  session.forceReconnect();
  session.connect();
  session.ws.open();
  session.receiveState({ ...server, seq: 1 });
  assert.deepEqual(session.lattice.toFrame(), bank);
  assert.equal(session.statusSnapshot().structureGestures, 1);
  const resend = session.ws.frames.at(-1);
  assert.equal(resend.intent, 'flush');
  session.receiveAck({ frameId: resend.frameId });
  assert.deepEqual({ pending: session.statusSnapshot().structurePending, gestures: session.statusSnapshot().structureGestures }, { pending: 0, gestures: 0 });
  assert.deepEqual(session.confirmedStructure.toFrame(), bank);
});

test('a newer accepted gesture cannot clear an older refused write to another record', (t) => {
  const { session } = connectedSession(t);
  session.dispatch({ kind: 'CreateNode', id: 'child', label: 'Pending child', prerequisites: ['root'] });
  refuseLast(session, 'structure');
  const refusal = session.statusSnapshot().refused;
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Accepted root' });
  session.receiveAck({ frameId: [...session.inFlight.keys()].at(-1) });
  assert.equal(session.statusSnapshot().structureGestures, 1);
  assert.equal(session.statusSnapshot().structurePending, 2);
  assert.equal(session.statusSnapshot().refused, refusal);
  assert.deepEqual(snapshot(session), [
    { id: 'root', label: 'Accepted root', prerequisites: [] },
    { id: 'child', label: 'Pending child', prerequisites: ['root'] },
  ]);
});

test('one chunk acknowledgement cannot clear a partly confirmed multi-record gesture', (t) => {
  const { session } = connectedSession(t);
  session.phase = 'offline';
  const ids = Array.from({ length: 8 }, (_, index) => `large-${index}`);
  session.dispatch({ kind: 'ImportSubgraph', nodes: ids.map((id) => ({ id, label: id, description: 'x'.repeat(50000) })), edges: [] });
  assert.equal(session.statusSnapshot().structureGestures, 1);
  session.phase = 'live';
  session.flush();
  const frames = [...session.inFlight.keys()];
  assert.ok(frames.length > 1);
  const firstSize = session.structureWrites.get(frames[0]).nodes.length;
  session.receiveAck({ frameId: frames[0] });
  assert.equal(session.statusSnapshot().structureGestures, 1);
  assert.equal(session.statusSnapshot().structurePending, ids.length - firstSize);
  session.receiveReject({ frameId: frames.at(-1), code: 'bad-frame' });
  const refusal = session.statusSnapshot().refused;
  session.noteDrained();
  assert.equal(session.statusSnapshot().structureGestures, 1);
  assert.equal(session.statusSnapshot().refused, refusal);
  for (const frameId of frames.slice(1)) {
    if (session.inFlight.has(frameId)) session.receiveAck({ frameId });
  }
  assert.equal(session.statusSnapshot().structureGestures, 1);
});
