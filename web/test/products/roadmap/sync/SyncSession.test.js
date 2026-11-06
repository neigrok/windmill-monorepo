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

function connectedSession(t, overrides = {}, options = {}) {
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
  const session = new SyncSession({ treeId: 'tree', store, registry: null, ...options });
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
  const unconfirmed = session.unconfirmedWrites.bind(session);
  t.mock.method(session, 'unconfirmedWrites', (lane) => {
    reads.push(lane);
    return unconfirmed(lane);
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
  const pendingStructureCount = session.pendingStructureCount.bind(session);
  const unconfirmed = session.unconfirmedWrites.bind(session);
  t.mock.method(session, 'statusSnapshot', () => { snapshots += 1; return statusSnapshot(); });
  t.mock.method(session, 'pendingStructureCount', () => { pendingReads += 1; return pendingStructureCount(); });
  t.mock.method(session, 'unconfirmedWrites', (lane) => {
    deltaReads += 1;
    return unconfirmed(lane);
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
  session.receiveState({ ...session.confirmedStructure.toFrame(), seq: 1 });
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
  const firstSize = session.inFlight.get(frames[0]).nodes.length;
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

test('a send the browser cannot make reports once and stands the existing refused card, with the bank kept', async (t) => {
  const failure = new Error('private storage');
  const { session } = connectedSession(t, { withEpoch: async () => { throw failure; } });
  const reports = [];
  session.reportFailure = (operation, error) => reports.push({ operation, error });
  const states = [];
  session.subscribeStatus((state) => states.push(state));
  const receipt = session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Unsent' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  assert.deepEqual(reports, [{ operation: 'roadmap-sync-send', error: failure }]);
  assert.deepEqual({ lane: states.at(-1).refused.lane, code: states.at(-1).refused.code, gestures: states.at(-1).structureGestures }, { lane: 'structure', code: 'unsendable', gestures: 1 });
  assert.equal(session.lattice.toTreeData().nodes[0].label, 'Unsent');
  session.retry();
  assert.equal(session.statusSnapshot().refused, null);
});

test('a socket frame that is not JSON and one that does not parse as a lane report once each session and heal', (t) => {
  const { session } = connectedSession(t);
  const reports = [];
  session.reportFailure = (operation) => reports.push(operation);
  session.ws.message('x');
  session.ws.dispatchEvent(new MessageEvent('message', { data: '{not json' }));
  session.ws.dispatchEvent(new MessageEvent('message', { data: '{not json' }));
  assert.deepEqual(reports, ['roadmap-sync-frame']);
  session.connect();
  session.ws.open();
  session.receiveState({ t: 'subgraph', intent: 'delta', seq: 2, nodes: [{ id: null }], edges: [], kinds: [] });
  session.connect();
  session.ws.open();
  session.receiveProgressGraft({ marks: [{ node: null }] });
  assert.deepEqual(reports, ['roadmap-sync-frame']);
  assert.equal(session.phase, 'offline');
});

test('a socket unanswered past its bound, online and in view, reports once; offline and hidden do not', (t) => {
  t.mock.method(globalThis, 'setTimeout', () => 0);
  t.mock.method(globalThis, 'setInterval', () => 0);
  t.mock.method(globalThis, 'clearInterval', () => {});
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const priors = ['WebSocket', 'window', 'document'].map((key) => [key, globalThis[key]]);
  globalThis.WebSocket = TestSocket;
  globalThis.window = new EventTarget();
  globalThis.document = { visibilityState: 'visible' };
  t.after(() => { for (const [key, value] of priors) globalThis[key] = value; });
  const reports = [];
  const session = new SyncSession({ treeId: 'tree', registry: null, store: { save: async () => {} }, reportFailure: (operation) => reports.push(operation) });
  session.connect();
  session.ws.close();
  session.connect();
  t.mock.timers.tick(9999);
  session.ws.close();
  assert.deepEqual(reports, []);
  session.online = false;
  session.connect();
  t.mock.timers.tick(5000);
  session.ws.close();
  assert.deepEqual(reports, []);
  session.online = true;
  document.visibilityState = 'hidden';
  session.connect();
  session.ws.close();
  assert.deepEqual(reports, []);
  document.visibilityState = 'visible';
  session.connect();
  session.ws.close();
  session.connect();
  session.ws.close();
  assert.deepEqual(reports, ['roadmap-sync-socket']);
});

test('any answer proves the socket: a reject keeps a device tree quiet and a reconnect starts its own bound', (t) => {
  const { session } = connectedSession(t);
  const reports = [];
  session.reportFailure = (operation) => reports.push(operation);
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  session.connect();
  session.ws.open();
  t.mock.timers.tick(30000);
  session.ws.message({ t: 'reject', code: 'nobodys-tree' });
  session.ws.close();
  assert.deepEqual(reports, []);
  assert.equal(session.unansweredSince, null);
});

test('a mark the store refuses reports its save, and the mark still goes to the server', async (t) => {
  const failure = new Error('private storage');
  const { session } = connectedSession(t, { save: async () => { throw failure; } });
  const reports = [];
  session.reportFailure = (operation, error) => reports.push({ operation, error });
  session.markProgress('root', 'complete');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reports, [{ operation: 'roadmap-sync-persist', error: failure }]);
  assert.equal(session.ws.frames.at(-1).t, 'progress');
  assert.equal(session.durabilityAtRisk, true);
});

test('a stored lane that cannot be read reports once, stays out of the room and leaves the rest to the graft', async (t) => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const priorSocket = globalThis.WebSocket;
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  globalThis.WebSocket = TestSocket;
  t.after(() => { globalThis.window = priorWindow; globalThis.document = priorDocument; globalThis.WebSocket = priorSocket; });
  const reports = [];
  const trees = [];
  const unreadable = { nodes: 'private', edges: 7, kinds: 7, marks: 'private' };
  const session = new SyncSession({ treeId: 'tree', title: 'Sail', registry: null, reportFailure: (operation) => reports.push(operation),
    store: { load: async () => ({ frame: unreadable, progress: unreadable, lastSeq: 9, epochs: { structure: 0, progress: 0 }, confirmed: { structure: unreadable, progress: unreadable } }),
      requestPersistent: async () => true, save: async () => {} } });
  t.after(() => session.close());
  session.onTreeChanged((tree) => trees.push(tree));
  await session.start();
  assert.deepEqual(reports, ['roadmap-sync-restore']);
  assert.deepEqual(trees, []);
  assert.deepEqual({ ready: session.ready, lastSeq: session.lastSeq, title: session.lattice.title, known: session.confirmedKnown }, { ready: false, lastSeq: 0, title: 'Sail', known: { structure: false, progress: false } });
  session.ws.open();
  session.receiveState({ t: 'subgraph', intent: 'delta', seq: 1, nodes: [{ id: 'root', createdAt: '1:0:server', label: 'Root', labelAt: '1:0:server' }], edges: [], kinds: [] });
  assert.equal(trees.at(-1).nodes[0].label, 'Root');
  assert.equal(session.ready, true);
});

test('a store that cannot load reports once and the session goes on to the server', async (t) => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const priorSocket = globalThis.WebSocket;
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  globalThis.WebSocket = TestSocket;
  t.after(() => { globalThis.window = priorWindow; globalThis.document = priorDocument; globalThis.WebSocket = priorSocket; });
  const reports = [];
  const session = new SyncSession({ treeId: 'tree', registry: null, reportFailure: (operation) => reports.push(operation),
    store: { load: async () => { throw new Error('private read'); }, requestPersistent: async () => true, save: async () => {} } });
  t.after(() => session.close());
  await session.start();
  assert.deepEqual(reports, ['roadmap-sync-restore']);
  assert.ok(session.ws);
});

for (const [name, frame] of [
  ['a live frame', { t: 'subgraph', seq: 2, nodes: [{ id: 'peer', createdAt: '999:0:peer' }], edges: [], kinds: [] }],
  ['a graft', { t: 'subgraph', intent: 'delta', seq: 2, nodes: [{ id: 'peer', createdAt: '999:0:peer' }], edges: [], kinds: [] }],
  ['a progress echo', { t: 'progress', marks: [{ node: 'root', status: 'complete', at: '999:0:peer' }] }],
  ['a progress graft', { t: 'progress', intent: 'graft', marks: [{ node: 'root', status: 'complete', at: '999:0:peer' }] }],
]) {
  test(`${name} whose notification fails reports roadmap-sync-notify and the session stands`, (t) => {
    const { session } = connectedSession(t);
    const failure = new Error('private notification');
    const reports = [];
    session.reportFailure = (operation, error) => reports.push({ operation, error });
    session.onTreeChanged(() => { throw failure; });
    session.onProgress(() => { throw failure; });
    assert.doesNotThrow(() => session.ws.message(frame));
    assert.deepEqual(reports, [{ operation: 'roadmap-sync-notify', error: failure }]);
    assert.equal(session.phase, 'live');
  });
}

test('one act is one change however many records it wrote', () => {
  const session = sessionWith();
  session.dispatch({ kind: 'CreateNode', id: 'middle', label: 'Middle', parentId: 'root' });
  session.dispatch({ kind: 'CreateNode', id: 'child', label: 'Child', parentId: 'middle' });
  const before = session.pendingEditCount();
  session.dispatch({ kind: 'BulkDelete', nodeIds: ['middle'] });
  assert.equal(session.pendingEditCount(), before + 1);
  assert.ok(session.statusSnapshot().structurePending > 1);
});

test('a revert leaves a field written since its receipt, by this person or a peer, and takes back the rest', () => {
  const session = sessionWith();
  const receipt = session.dispatch({ kind: 'EditNode', id: 'root', label: 'Edited', color: 'sky', addPrerequisites: [], removePrerequisites: [] });
  session.dispatch({ kind: 'SetNodeColor', id: 'root', color: 'gold' });
  assert.equal(session.revert(receipt), true);
  assert.deepEqual([session.lattice.toTreeData().nodes[0].label, session.lattice.toTreeData().nodes[0].color], ['Root', 'gold']);
  const peered = session.dispatch({ kind: 'SetNodeColor', id: 'root', color: 'olive' });
  session.lattice.join({ nodes: [{ id: 'root', color: 'plum', colorAt: `${Date.now() + 60000}:0:peer` }] });
  assert.equal(session.revert(peered), true);
  assert.equal(session.lattice.toTreeData().nodes[0].color, 'plum');
  assert.deepEqual(session.undoStack.length, 1);
});

test('a delete a peer deleted again stays deleted through its revert, and an edge a peer rewrote stays as they left it', () => {
  const session = sessionWith();
  session.dispatch({ kind: 'CreateNode', id: 'child', label: 'Child', parentId: 'root' });
  const deleted = session.dispatch({ kind: 'DeleteNode', id: 'child' });
  session.lattice.join({ nodes: [{ id: 'child', deletedAt: `${Date.now() + 60000}:0:peer` }] });
  assert.equal(session.revert(deleted), true);
  assert.deepEqual(snapshot(session).map(({ id }) => id), ['root']);
  session.dispatch({ kind: 'CreateNode', id: 'other', label: 'Other' });
  const linked = session.dispatch({ kind: 'AddEdge', from: 'root', to: 'other' });
  const writes = [];
  session.apply = ((apply) => (next) => { writes.push(next); apply.call(session, next); })(session.apply);
  session.lattice.join({ edges: [{ from: 'root', to: 'other', addedAt: `${Date.now() + 90000}:0:peer` }] });
  assert.equal(session.revert(linked), true);
  assert.deepEqual(writes, []);
  assert.equal(session.lattice.edgePresent('root', 'other'), true);
});

test('Undo and Redo spend receipts and say so, so a toast backed by one can leave', () => {
  const session = sessionWith();
  const versions = [];
  session.subscribeStatus((state) => versions.push(state.receiptVersion));
  const receipt = session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Renamed' });
  assert.equal(versions.at(-1), 0);
  session.undo();
  assert.equal(versions.at(-1), 1);
  session.redo();
  assert.equal(versions.at(-1), 2);
  assert.equal(session.revert(receipt), false);
});

test('Undo takes a held act back before anything on the stack, and the stack stays as it was', () => {
  const session = sessionWith();
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Renamed' });
  const cancelled = [];
  session.holdAct(() => { cancelled.push(true); session.endHeldAct(); });
  session.undo();
  assert.deepEqual(cancelled, [true]);
  assert.deepEqual([session.lattice.toTreeData().nodes[0].label, session.undoStack.length, session.redoStack.length], ['Renamed', 1, 0]);
  session.undo();
  assert.deepEqual([session.lattice.toTreeData().nodes[0].label, session.undoStack.length, session.redoStack.length], ['Root', 0, 1]);
});

test('a write made as the session closes still reaches the socket, and only then does the socket close', async (t) => {
  let check;
  const { session } = connectedSession(t, { withEpoch: (treeId, lane, epoch, send) => new Promise((resolve) => {
    check = () => { send(); resolve({ status: 'current' }); };
  }) });
  const socket = session.ws;
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Last' });
  session.close();
  assert.equal(socket.readyState, TestSocket.OPEN);
  check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.frames.at(-1).nodes[0].label, 'Last');
  assert.equal(socket.readyState, 3);
});

test('leaving the page saves and sends at once: nothing waits on an epoch read or a callback', (t) => {
  const left = [];
  const { session } = connectedSession(t, {
    withEpoch: () => { throw new Error('leaving does not read'); },
    saveWhileLeaving: async (treeId, value) => { left.push(value.frame.nodes[0].label); return { status: 'saved' }; },
  });
  const socket = session.ws;
  session.leavePage();
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Left' });
  assert.deepEqual(left, ['Left']);
  assert.equal(socket.frames.at(-1).nodes[0].label, 'Left');
});

test('an ordinary page leave reads before it saves, so it cannot overwrite what another tab stored', async (t) => {
  const priorDocument = globalThis.document;
  const priorSocket = globalThis.WebSocket;
  const priorWindow = globalThis.window;
  globalThis.document = new EventTarget();
  globalThis.WebSocket = TestSocket;
  globalThis.window = new EventTarget();
  t.after(() => { globalThis.document = priorDocument; globalThis.WebSocket = priorSocket; globalThis.window = priorWindow; });
  const saved = [];
  const session = new SyncSession({ treeId: 'tree', registry: null, store: {
    load: async () => null, requestPersistent: async () => true,
    save: async (treeId, value) => { saved.push('read-first'); return { status: 'saved', value }; },
    saveWhileLeaving: async () => { saved.push('blind'); return { status: 'saved' }; },
  } });
  t.after(() => session.close());
  await session.start();
  window.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(saved, ['read-first']);
  session.leavePage();
  window.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(saved, ['read-first']);
  window.dispatchEvent(new Event('pageshow'));
  window.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(saved, ['read-first', 'read-first']);
});

const withoutFrameId = ({ frameId, ...frame }) => frame;
const structureFrames = (socket) => socket.frames.filter((frame) => frame.t === 'subgraph');
const progressFrames = (socket) => socket.frames.filter((frame) => frame.t === 'progress');
const flushFrame = (writes, actor) => ({ t: 'subgraph', v: 1, treeId: 'tree', actor, intent: 'flush', ...writes });
const writesOf = ({ nodes = [], edges = [], kinds = [], title }) => ({ nodes, edges, kinds, ...(title ? { title } : {}) });

function reconnectWith(session, frame, coverage) {
  session.retry();
  session.connect();
  session.ws.open();
  session.receiveState({ ...frame, seq: 1, coverage });
  return session.ws;
}

function manualTimers() {
  const pending = new Map();
  const intervals = new Map();
  let next = 0;
  return {
    pending, intervals,
    setTimeout(run, delay) { const id = ++next; pending.set(id, { run, delay }); return id; },
    clearTimeout(id) { pending.delete(id); },
    setInterval(run) { const id = ++next; intervals.set(id, run); return id; },
    clearInterval(id) { intervals.delete(id); },
    heartbeat() { for (const run of [...intervals.values()]) run(); },
    run(id) { const timer = pending.get(id); assert.ok(timer); pending.delete(id); timer.run(); },
  };
}

test('S1 retry resends an older refused field after a newer field is acknowledged', (t) => {
  const { session } = connectedSession(t);
  let drained = 0;
  session.onDrained(() => { drained += 1; });
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'A' });
  session.dispatch({ kind: 'DescribeNode', id: 'root', description: 'D' });
  const [first, second] = structureFrames(session.ws);
  session.receiveReject({ frameId: first.frameId, code: 'tree-too-large' });
  session.receiveAck({ frameId: second.frameId });
  const socket = reconnectWith(session, { nodes: [], edges: [], kinds: [] }, { server: '1:0:server', [session.actor]: second.nodes[0].descriptionAt });
  assert.deepEqual(structureFrames(socket).map(withoutFrameId), [flushFrame(writesOf(first), session.actor)]);
  session.receiveAck({ frameId: structureFrames(socket)[0].frameId });
  assert.equal(session.pendingStructureCount(), 0);
  assert.equal(drained, 1);
});

test('S1 control a newer acknowledged value on the same register needs no resend', (t) => {
  const { session } = connectedSession(t);
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'A' });
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'B' });
  const [first, second] = structureFrames(session.ws);
  session.receiveReject({ frameId: first.frameId, code: 'tree-too-large' });
  session.receiveAck({ frameId: second.frameId });
  const socket = reconnectWith(session, { nodes: [], edges: [], kinds: [] }, { server: '1:0:server', [session.actor]: second.nodes[0].labelAt });
  assert.deepEqual(structureFrames(socket), []);
  assert.equal(session.pendingStructureCount(), 0);
});

test('S1 reload resends an older refused field under its original actor', async (t) => {
  const { session, saves } = connectedSession(t);
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'A' });
  session.dispatch({ kind: 'DescribeNode', id: 'root', description: 'D' });
  const [first, second] = structureFrames(session.ws);
  session.receiveReject({ frameId: first.frameId, code: 'tree-too-large' });
  session.receiveAck({ frameId: second.frameId });
  await session.persistNow();
  const record = structuredClone(saves.at(-1));
  session.close();
  const priorDocument = globalThis.document;
  globalThis.document = new EventTarget();
  t.after(() => { globalThis.document = priorDocument; });
  const restored = new SyncSession({ treeId: 'tree', registry: null, store: {
    load: async () => record, save: async () => {}, requestPersistent: async () => true,
  } });
  t.after(() => restored.close());
  await restored.start();
  restored.ws.open();
  restored.receiveState({ ...session.confirmedStructure.toFrame(), seq: 1,
    coverage: { server: '1:0:server', [session.actor]: second.nodes[0].descriptionAt } });
  assert.notEqual(restored.actor, session.actor);
  assert.deepEqual(structureFrames(restored.ws).map(withoutFrameId), [flushFrame(writesOf(first), restored.actor)]);
});

test('S2 retry resends exactly the rejected chunk of a shared-stamp import', (t) => {
  const { session } = connectedSession(t, {}, { chunkBytes: 300 });
  session.phase = 'offline';
  session.dispatch({ kind: 'ImportSubgraph', nodes: Array.from({ length: 8 }, (_, i) => ({ id: `import-${i}`, label: `Node ${i}` })), edges: [] });
  session.phase = 'live';
  session.flush();
  const chunks = structureFrames(session.ws);
  assert.ok(chunks.length >= 3);
  session.receiveAck({ frameId: chunks[0].frameId });
  session.receiveReject({ frameId: chunks[1].frameId, code: 'tree-too-large' });
  for (const frame of chunks.slice(2)) session.receiveAck({ frameId: frame.frameId });
  const socket = reconnectWith(session, { nodes: [], edges: [], kinds: [] }, session.confirmedStructure.frontier().toJSON());
  assert.deepEqual(structureFrames(socket).map(withoutFrameId), [flushFrame(writesOf(chunks[1]), session.actor)]);
  for (const frame of structureFrames(socket)) session.receiveAck({ frameId: frame.frameId });
  assert.equal(session.statusSnapshot().structureGestures, 0);
});

test('S3 a later chunk frontier cannot mask older registers in the rejected chunk', (t) => {
  const { session } = connectedSession(t, {}, { chunkBytes: 230 });
  const writes = { nodes: [{ id: 'root', label: 'Older', labelAt: '30:0:r_test', description: 'Newer', descriptionAt: '33:0:r_test' }],
    edges: [{ from: 'root', to: 'a', addedAt: '31:0:r_test' }, { from: 'root', to: 'b', addedAt: '32:0:r_test' }], kinds: [] };
  session.lattice.join(writes);
  session.flush();
  const chunks = structureFrames(session.ws);
  assert.equal(chunks.length, 2);
  session.receiveReject({ frameId: chunks[0].frameId, code: 'tree-too-large' });
  session.receiveAck({ frameId: chunks[1].frameId });
  const socket = reconnectWith(session, { nodes: [], edges: [], kinds: [] }, session.confirmedStructure.frontier().toJSON());
  assert.deepEqual(structureFrames(socket).map(withoutFrameId), [flushFrame(writesOf(chunks[0]), session.actor)]);
});

test('S4 a later ack settles a silent drop, reports once and resends only its field', (t) => {
  const timers = manualTimers();
  const reports = [];
  const { session } = connectedSession(t, {}, { timers, reportFailure: (...args) => reports.push(args) });
  let drained = 0;
  session.onDrained(() => { drained += 1; });
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Lost' });
  session.dispatch({ kind: 'SetNodeColor', id: 'root', color: 'sky' });
  const [first, second] = structureFrames(session.ws);
  session.receiveAck({ frameId: second.frameId });
  assert.equal(session.inFlight.has(first.frameId), false);
  assert.equal(session.statusSnapshot().structureInFlight, 0);
  assert.equal(reports.length, 1);
  assert.deepEqual([reports[0][0], reports[0][1].message, reports[0][2]], ['roadmap-sync-dropped', 'Roadmap frame unanswered', { lane: 'structure' }]);
  assert.ok(reports[0][1] instanceof Error);
  assert.ok(reports[0][1].stack);
  assert.equal(timers.pending.get(session.resendTimers.structure).delay, 1000);
  timers.run(session.resendTimers.structure);
  assert.deepEqual(structureFrames(session.ws).slice(2).map(withoutFrameId), [flushFrame(writesOf(first), session.actor)]);
  session.receiveAck({ frameId: structureFrames(session.ws).at(-1).frameId });
  assert.equal(session.pendingStructureCount(), 0);
  assert.equal(drained, 1);
});

test('S4 a standing refusal suppresses resend after earlier unanswered frames settle', (t) => {
  const timers = manualTimers();
  const { session } = connectedSession(t, {}, { timers });
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Refused' });
  refuseLast(session, 'structure', 'tree-too-large');
  session.dispatch({ kind: 'DescribeNode', id: 'root', description: 'Dropped' });
  session.dispatch({ kind: 'SetNodeColor', id: 'root', color: 'sky' });
  session.receiveAck({ frameId: structureFrames(session.ws).at(-1).frameId });
  assert.equal(session.inFlight.size, 0);
  assert.equal(session.resendTimers.structure, null);
  assert.deepEqual(structureFrames(session.ws).slice(3), []);
});

for (const lane of ['structure', 'progress']) {
  test(`S5 skew settles ${lane} and retries all its registers after the deficit`, (t) => {
    const timers = manualTimers();
    const { session } = connectedSession(t, {}, { timers });
    if (lane === 'structure') {
      session.lattice.join({ nodes: [{ id: 'root', label: 'Old', labelAt: '30:0:r_skew', description: 'Future', descriptionAt: '900000:0:r_skew' }] });
      session.flush();
      const ordinary = { nodes: [{ id: 'root', color: 'sky', colorAt: '32:0:r_skew' }], edges: [], kinds: [] };
      session.lattice.join(ordinary);
      session.send(ordinary);
    } else {
      session.progress.join({ marks: [{ node: 'a', status: 'complete', at: '900000:0:r_skew' }] });
      session.flushProgress();
      session.progress.join({ marks: [{ node: 'b', status: 'complete', at: '32:0:r_skew' }] });
      session.flushProgress();
    }
    const frames = lane === 'structure' ? structureFrames(session.ws) : progressFrames(session.ws);
    const [first, second] = frames;
    session.receiveSkew({ frameId: first.frameId, serverNow: 1000 });
    if (lane === 'structure') session.receiveAck({ frameId: second.frameId });
    else session.receiveProgressAck({ frameId: second.frameId });
    assert.equal((lane === 'structure' ? session.inFlight : session.progressInFlight).size, 0);
    assert.equal(session.statusSnapshot()[`${lane}InFlight`], 0);
    assert.equal(timers.pending.get(session.skewTimers[lane]).delay, 900000);
    timers.run(session.skewTimers[lane]);
    const resent = lane === 'structure' ? structureFrames(session.ws).slice(2) : progressFrames(session.ws).slice(2);
    assert.deepEqual(resent.map(withoutFrameId), [lane === 'structure' ? flushFrame(writesOf(first), session.actor) : withoutFrameId(first)]);
  });
}

test('S6 progress resend excludes confirmed marks and never sends receipt instants', (t) => {
  const { session } = connectedSession(t);
  session.markProgress('a', 'complete');
  session.markProgress('b', 'complete');
  const [first, second] = progressFrames(session.ws);
  assert.deepEqual(first.marks, [{ node: 'a', status: 'complete', at: session.progress.toFrame().marks.find((mark) => mark.node === 'a').at }]);
  assert.deepEqual(second.marks, [{ node: 'b', status: 'complete', at: session.progress.toFrame().marks.find((mark) => mark.node === 'b').at }]);
  session.receiveProgressAck({ frameId: second.frameId });
  const socket = reconnectWith(session, session.confirmedStructure.toFrame(), session.confirmedStructure.frontier().toJSON());
  session.receiveProgressGraft({ marks: second.marks });
  assert.deepEqual(progressFrames(socket).map(withoutFrameId), [withoutFrameId(first)]);
  session.receiveProgressAck({ frameId: progressFrames(socket)[0].frameId });
  assert.equal(session.pendingProgressCount(), 0);
});

test('S7 an own echo cannot confirm before the ack and reconnect resends it', (t) => {
  const { session } = connectedSession(t);
  const baseline = session.confirmedStructure.toFrame();
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Echoed' });
  const first = structureFrames(session.ws)[0];
  session.receiveLive({ ...first, seq: 2 });
  assert.equal(session.statusSnapshot().structurePending, 1);
  const socket = reconnectWith(session, baseline, { server: '1:0:server' });
  assert.deepEqual(structureFrames(socket).map(withoutFrameId), [flushFrame(writesOf(first), session.actor)]);
  session.receiveAck({ frameId: structureFrames(socket)[0].frameId });
  assert.equal(session.pendingStructureCount(), 0);
});

test('a late ack of a settled drop cannot confirm; only the resend can', (t) => {
  const timers = manualTimers();
  const { session } = connectedSession(t, {}, { timers });
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Dropped' });
  session.dispatch({ kind: 'DescribeNode', id: 'root', description: 'Accepted' });
  const [first, second] = structureFrames(session.ws);
  session.receiveAck({ frameId: second.frameId });
  const confirmed = session.confirmedStructure.toFrame();
  session.receiveAck({ frameId: first.frameId });
  assert.deepEqual(session.confirmedStructure.toFrame(), confirmed);
  assert.equal(session.pendingStructureCount(), 1);
  timers.run(session.resendTimers.structure);
  assert.deepEqual(structureFrames(session.ws).slice(2).map(withoutFrameId), [flushFrame(writesOf(first), session.actor)]);
  session.receiveAck({ frameId: structureFrames(session.ws).at(-1).frameId });
  assert.equal(session.pendingStructureCount(), 0);
});

test('refusal episode follows unconfirmed registers across retry and changes with a new write', (t) => {
  const { session } = connectedSession(t);
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'A' });
  refuseLast(session, 'structure', 'tree-too-large');
  const episode = session.refusals.get('structure').episode;
  let socket = reconnectWith(session, session.confirmedStructure.toFrame(), session.confirmedStructure.frontier().toJSON());
  const firstRetry = structureFrames(socket)[0];
  session.receiveReject({ frameId: firstRetry.frameId, code: 'tree-too-large' });
  assert.equal(session.refusals.get('structure').episode, episode);
  socket = reconnectWith(session, session.confirmedStructure.toFrame(), session.confirmedStructure.frontier().toJSON());
  const secondRetry = structureFrames(socket)[0];
  session.dispatch({ kind: 'DescribeNode', id: 'root', description: 'Extra' });
  session.receiveReject({ frameId: secondRetry.frameId, code: 'tree-too-large' });
  assert.notEqual(session.refusals.get('structure').episode, episode);
  assert.deepEqual(withoutFrameId(secondRetry), withoutFrameId(firstRetry));
});

test('a title-only flush survives a title larger than the chunk budget', (t) => {
  const { session } = connectedSession(t, {}, { chunkBytes: 20 });
  session.phase = 'offline';
  session.renameTree('A title larger than the chunk budget');
  const title = session.lattice.toFrame().title;
  session.phase = 'live';
  session.flush();
  assert.deepEqual(structureFrames(session.ws).map(withoutFrameId), [flushFrame({ nodes: [], edges: [], kinds: [], title }, session.actor)]);
});

test('drop settlement is lane-local and coalesces resend with exponential backoff until drain', (t) => {
  const timers = manualTimers();
  const reports = [];
  const { session } = connectedSession(t, {}, { timers, reportFailure: (operation, error, tags) => reports.push({ operation, message: error.message, tags }) });
  session.markProgress('a', 'complete');
  const progress = [...session.progressInFlight];
  for (const description of ['First', 'Second']) {
    session.dispatch({ kind: 'RenameNode', id: 'root', label: description });
    session.dispatch({ kind: 'DescribeNode', id: 'root', description });
    session.receiveAck({ frameId: structureFrames(session.ws).at(-1).frameId });
  }
  const firstTimer = session.resendTimers.structure;
  assert.equal(timers.pending.get(firstTimer).delay, 1000);
  assert.equal([...timers.pending.values()].filter(({ delay }) => delay === 1000).length, 1);
  assert.deepEqual([...session.progressInFlight], progress);
  timers.run(firstTimer);
  session.dispatch({ kind: 'SetNodeColor', id: 'root', color: 'sky' });
  session.receiveAck({ frameId: structureFrames(session.ws).at(-1).frameId });
  assert.equal(timers.pending.get(session.resendTimers.structure).delay, 2000);
  timers.run(session.resendTimers.structure);
  session.receiveAck({ frameId: structureFrames(session.ws).at(-1).frameId });
  assert.equal(session.resendBackoffMs.structure, 1000);
  assert.equal(session.resendTimers.structure, null);
  assert.deepEqual([...session.progressInFlight], progress);
  assert.deepEqual(reports, [{ operation: 'roadmap-sync-dropped', message: 'Roadmap frame unanswered', tags: { lane: 'structure' } }]);
});

for (const boundary of ['socket close', 'close', 'adoptEpochs']) {
  test(`resend and skew timers on both lanes are cancelled by ${boundary}`, (t) => {
    const timers = manualTimers();
    const { session, saves } = connectedSession(t, {}, { timers });
    session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Dropped' });
    session.dispatch({ kind: 'DescribeNode', id: 'root', description: 'Skewed' });
    session.receiveSkew({ frameId: structureFrames(session.ws).at(-1).frameId, serverNow: Date.now() });
    session.markProgress('a', 'complete');
    session.markProgress('b', 'complete');
    session.receiveSkew({ frameId: progressFrames(session.ws).at(-1).frameId, serverNow: Date.now() });
    const ids = [...Object.values(session.resendTimers), ...Object.values(session.skewTimers)];
    assert.equal(ids.every((id) => timers.pending.has(id)), true);
    if (boundary === 'socket close') session.ws.close();
    if (boundary === 'close') session.close();
    if (boundary === 'adoptEpochs') {
      const record = structuredClone(saves.at(-1));
      record.epochs.structure += 1;
      session.adoptEpochs(record);
    }
    assert.deepEqual(session.resendTimers, { structure: null, progress: null });
    assert.deepEqual(session.skewTimers, { structure: null, progress: null });
    assert.equal(ids.some((id) => timers.pending.has(id)), false);
  });
}

for (const lane of ['structure', 'progress']) {
  test(`a server restore after reload invalidates the ${lane} confirmed baseline and resends its lost writes`, async (t) => {
    const { session, saves } = connectedSession(t);
    const baseline = session.confirmedStructure.toFrame();
    if (lane === 'structure') {
      session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Saved before restore' });
      session.receiveAck({ frameId: structureFrames(session.ws)[0].frameId });
    } else {
      session.markProgress('root', 'complete');
      session.receiveProgressAck({ frameId: progressFrames(session.ws)[0].frameId });
    }
    const original = (lane === 'structure' ? structureFrames(session.ws) : progressFrames(session.ws))[0];
    await session.persistNow();
    const record = structuredClone(saves.at(-1));
    session.close();
    const priorDocument = globalThis.document;
    globalThis.document = new EventTarget();
    t.after(() => { globalThis.document = priorDocument; });
    const restored = new SyncSession({ treeId: 'tree', registry: null, store: {
      load: async () => record, save: async () => {}, requestPersistent: async () => true,
    } });
    t.after(() => restored.close());
    await restored.start();
    restored.ws.open();
    restored.receiveState({ ...baseline, seq: 1, coverage: { server: '1:0:server' } });
    restored.receiveProgressGraft({ marks: [] });
    assert.equal(restored.statusSnapshot()[`${lane}Gestures`], 1);
    if (lane === 'structure') {
      assert.deepEqual(structureFrames(restored.ws).map(withoutFrameId), [flushFrame(writesOf(original), restored.actor)]);
      restored.receiveAck({ frameId: structureFrames(restored.ws)[0].frameId });
    } else {
      assert.deepEqual(progressFrames(restored.ws).map(withoutFrameId), [withoutFrameId(original)]);
      restored.receiveProgressAck({ frameId: progressFrames(restored.ws)[0].frameId });
    }
    assert.deepEqual([restored.pendingStructureCount(), restored.pendingProgressCount()], [0, 0]);
  });
}

test('a regressed peer frontier rebuilds structure confirmation even when the graft payload is partial', (t) => {
  const { session } = connectedSession(t);
  const baseline = session.confirmedStructure.toFrame();
  const peer = { nodes: [{ id: 'root', description: 'Peer write', descriptionAt: '9:0:peer' }], edges: [], kinds: [] };
  session.receiveLive({ ...peer, seq: 2 });
  assert.equal(session.pendingStructureCount(), 0);
  const socket = reconnectWith(session, { nodes: [], edges: [], kinds: [] }, { server: '1:0:server', peer: '5:0:peer' });
  assert.deepEqual(structureFrames(socket).map(withoutFrameId), [flushFrame({
    ...baseline, nodes: [{ ...baseline.nodes[0], ...peer.nodes[0] }],
  }, session.actor)]);
  assert.deepEqual(session.confirmedStructure.toFrame(), { nodes: [], edges: [], kinds: [] });
});

test('a non-regressing partial graft preserves confirmed registers omitted from its delta', (t) => {
  const { session } = connectedSession(t);
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Confirmed' });
  session.receiveAck({ frameId: structureFrames(session.ws)[0].frameId });
  const before = session.confirmedStructure.toFrame();
  const coverage = session.confirmedStructure.frontier().toJSON();
  const peer = { nodes: [{ id: 'root', description: 'New peer write', descriptionAt: '9:0:peer' }], edges: [], kinds: [] };
  const socket = reconnectWith(session, peer, { ...coverage, peer: '9:0:peer' });
  assert.deepEqual(structureFrames(socket), []);
  assert.deepEqual(session.confirmedStructure.toFrame(), { ...before, nodes: [{ ...before.nodes[0], ...peer.nodes[0] }] });
  assert.equal(session.pendingStructureCount(), 0);
});

test('every whole progress graft replaces confirmation, including missing marks from an actor still covered', (t) => {
  const { session } = connectedSession(t);
  session.markProgress('a', 'complete');
  session.markProgress('b', 'complete');
  const [first, second] = progressFrames(session.ws);
  session.receiveProgressAck({ frameId: first.frameId });
  session.receiveProgressAck({ frameId: second.frameId });
  session.receiveProgressGraft({ marks: second.marks });
  assert.deepEqual(session.confirmedProgress.toFrame(), { marks: second.marks });
  assert.deepEqual(progressFrames(session.ws).slice(2).map(withoutFrameId), [withoutFrameId(first)]);
  assert.equal(session.pendingProgressCount(), 1);
});

test('ordinary acknowledgements do not scan the pending bank while resend backoff is raised', (t) => {
  const { session } = connectedSession(t);
  session.resendBackoffMs.structure = 4000;
  session.resendBackoffMs.progress = 4000;
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Local' });
  session.dispatch({ kind: 'DescribeNode', id: 'root', description: 'Later' });
  session.markProgress('root', 'complete');
  session.markProgress('second', 'complete');
  const reads = [];
  const unconfirmed = session.unconfirmedWrites.bind(session);
  t.mock.method(session, 'unconfirmedWrites', (lane) => { reads.push(lane); return unconfirmed(lane); });
  session.receiveAck({ frameId: structureFrames(session.ws)[0].frameId });
  session.receiveProgressAck({ frameId: progressFrames(session.ws)[0].frameId });
  assert.deepEqual(reads, []);
  session.receiveAck({ frameId: structureFrames(session.ws)[1].frameId });
  session.receiveProgressAck({ frameId: progressFrames(session.ws)[1].frameId });
  assert.deepEqual(reads, ['structure', 'progress']);
  assert.deepEqual(session.resendBackoffMs, { structure: 1000, progress: 1000 });
});

test('a covering acknowledgement cannot make different refusal banks share an episode', (t) => {
  const { session } = connectedSession(t);
  const stamp = '40:0:r_import';
  const first = { nodes: [{ id: 'root', label: 'Accepted chunk', labelAt: stamp }], edges: [], kinds: [] };
  const second = { nodes: [{ id: 'root', description: 'Refused chunk', descriptionAt: stamp }], edges: [], kinds: [] };
  for (const writes of [first, second]) { session.lattice.join(writes); session.send(writes); }
  const [accepted, refused] = structureFrames(session.ws);
  session.receiveAck({ frameId: accepted.frameId });
  session.receiveReject({ frameId: refused.frameId, code: 'tree-too-large' });
  const firstEpisode = session.refusals.get('structure').episode;
  const extra = { nodes: [{ id: 'root', color: 'sky', colorAt: stamp }], edges: [], kinds: [] };
  session.lattice.join(extra);
  session.send(extra);
  session.receiveReject({ frameId: structureFrames(session.ws).at(-1).frameId, code: 'tree-too-large' });
  assert.notEqual(session.refusals.get('structure').episode, firstEpisode);
  assert.deepEqual(structureFrames(session.ws).map(withoutFrameId), [first, second, extra].map((writes) => ({
    t: 'subgraph', v: 1, treeId: 'tree', actor: session.actor, intent: 'live', ...writes,
  })));
});

for (const lane of ['structure', 'progress']) {
  test(`a pong settles the final unanswered ${lane} frame and resends it`, (t) => {
    const timers = manualTimers();
    const reports = [];
    const { session } = connectedSession(t, {}, { timers, reportFailure: (operation, error, tags) => reports.push({ operation, message: error.message, tags }) });
    if (lane === 'structure') session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Final write' });
    else session.markProgress('root', 'complete');
    const frames = lane === 'structure' ? structureFrames : progressFrames;
    const original = frames(session.ws)[0];
    timers.heartbeat();
    assert.deepEqual(session.ws.frames.at(-1), { t: 'ping', treeId: 'tree' });
    session.ws.message({ t: 'pong' });
    assert.deepEqual([session.inFlight.size, session.progressInFlight.size], [0, 0]);
    assert.deepEqual(reports, [{ operation: 'roadmap-sync-dropped', message: 'Roadmap frame unanswered', tags: { lane } }]);
    timers.run(session.resendTimers[lane]);
    assert.deepEqual(frames(session.ws).slice(1).map(withoutFrameId), [lane === 'structure'
      ? flushFrame(writesOf(original), session.actor) : withoutFrameId(original)]);
  });
}

test('a pong settles both lanes only through the frames preceding its ping', (t) => {
  const timers = manualTimers();
  const { session } = connectedSession(t, {}, { timers });
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Before' });
  session.markProgress('a', 'complete');
  timers.heartbeat();
  session.dispatch({ kind: 'DescribeNode', id: 'root', description: 'After' });
  session.markProgress('b', 'complete');
  const laterStructure = structureFrames(session.ws)[1];
  const laterProgress = progressFrames(session.ws)[1];
  session.ws.message({ t: 'pong' });
  assert.deepEqual([...session.inFlight.keys()], [laterStructure.frameId]);
  assert.deepEqual([...session.progressInFlight.keys()], [laterProgress.frameId]);
  assert.deepEqual([session.pendingStructureCount(), session.pendingProgressCount()], [1, 2]);
});

test('a dropped ping cannot let a later pong settle writes after the oldest outstanding ping', (t) => {
  const timers = manualTimers();
  const { session } = connectedSession(t, {}, { timers });
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Before dropped ping' });
  session.markProgress('a', 'complete');
  timers.heartbeat();
  session.dispatch({ kind: 'DescribeNode', id: 'root', description: 'Before answered ping' });
  session.markProgress('b', 'complete');
  timers.heartbeat();
  session.dispatch({ kind: 'SetNodeColor', id: 'root', color: 'sky' });
  session.markProgress('c', 'complete');
  const structure = structureFrames(session.ws);
  const progress = progressFrames(session.ws);
  session.ws.message({ t: 'pong' });
  assert.deepEqual([...session.inFlight.keys()], structure.slice(1).map(({ frameId }) => frameId));
  assert.deepEqual([...session.progressInFlight.keys()], progress.slice(1).map(({ frameId }) => frameId));
});

for (const boundary of ['socket close', 'adoptEpochs', 'close']) {
  test(`a pong cannot use a ping boundary surviving ${boundary}`, (t) => {
    const timers = manualTimers();
    const { session, saves } = connectedSession(t, {}, { timers });
    session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Before boundary' });
    session.markProgress('a', 'complete');
    timers.heartbeat();
    const oldSocket = session.ws;
    if (boundary === 'socket close') session.ws.close();
    if (boundary === 'close') session.close();
    if (boundary === 'adoptEpochs') {
      const record = structuredClone(saves.at(-1));
      record.epochs.structure += 1;
      session.adoptEpochs(record);
    }
    assert.deepEqual(session.pingBoundaries, []);
    oldSocket.message({ t: 'pong' });
    assert.deepEqual(session.resendTimers, { structure: null, progress: null });
  });
}

test('an old own echo on the replacement connection cannot confirm before persistence', (t) => {
  const { session } = connectedSession(t);
  const baseline = session.confirmedStructure.toFrame();
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Old socket write' });
  const original = structureFrames(session.ws)[0];
  const socket = reconnectWith(session, baseline, { server: '1:0:server' });
  socket.message({ ...original, seq: 2 });
  assert.equal(session.pendingStructureCount(), 1);
  assert.deepEqual(session.confirmedStructure.toFrame(), baseline);
});

for (const lane of ['structure', 'progress']) {
  test(`a far-future ${lane} skew clamps its timer to the browser maximum`, (t) => {
    const timers = manualTimers();
    const { session } = connectedSession(t, {}, { timers });
    const at = '9000000000000:0:future';
    if (lane === 'structure') {
      session.lattice.join({ nodes: [{ id: 'root', label: 'Future', labelAt: at }] });
      session.flush();
    } else {
      session.progress.join({ marks: [{ node: 'root', status: 'complete', at }] });
      session.flushProgress();
    }
    const frames = lane === 'structure' ? structureFrames(session.ws) : progressFrames(session.ws);
    session.receiveSkew({ frameId: frames[0].frameId, serverNow: 1000 });
    assert.equal(timers.pending.get(session.skewTimers[lane]).delay, 2 ** 31 - 1);
  });
}

for (const lane of ['structure', 'progress']) {
  test(`a thrown ${lane} socket send reconnects without leaving a phantom in-flight frame`, (t) => {
    const timers = manualTimers();
    const reports = [];
    const { session } = connectedSession(t, {}, { timers, reportFailure: (operation, error) => reports.push({ operation, error }) });
    const baseline = session.confirmedStructure.toFrame();
    const failure = new Error('socket refused send');
    t.mock.method(session.ws, 'send', () => { throw failure; });
    assert.doesNotThrow(() => {
      if (lane === 'structure') session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Recover' });
      else session.markProgress('root', 'complete');
    });
    assert.deepEqual(reports, [{ operation: 'roadmap-sync-send', error: failure }]);
    assert.deepEqual([session.inFlight.size, session.progressInFlight.size], [0, 0]);
    assert.equal(session.phase, 'offline');
    assert.ok(timers.pending.has(session.reconnectTimer));
    timers.run(session.reconnectTimer);
    session.ws.open();
    session.receiveState({ ...baseline, seq: 1, coverage: { server: '1:0:server' } });
    session.receiveProgressGraft({ marks: [] });
    if (lane === 'structure') {
      const at = session.lattice.toFrame().nodes[0].labelAt;
      assert.deepEqual(structureFrames(session.ws).map(withoutFrameId), [flushFrame({ nodes: [{ id: 'root', label: 'Recover', labelAt: at }], edges: [], kinds: [] }, session.actor)]);
    } else {
      const at = session.progress.toFrame().marks[0].at;
      assert.deepEqual(progressFrames(session.ws).map(withoutFrameId), [{ t: 'progress', treeId: 'tree', marks: [{ node: 'root', status: 'complete', at }] }]);
    }
  });
}

test('an unexpected structure send failure leaves the write pending until reconnect resends it', (t) => {
  const timers = manualTimers();
  const reports = [];
  const { session } = connectedSession(t, {}, { timers, reportFailure: (operation, error) => reports.push({ operation, error }) });
  const baseline = session.confirmedStructure.toFrame();
  const failure = new Error('send boundary failure');
  const send = t.mock.method(session, 'send', () => { throw failure; });
  const receipt = session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Retained after failure' });
  assert.ok(receipt);
  assert.equal(session.pendingStructureCount(), 1);
  assert.deepEqual(reports, [{ operation: 'roadmap-sync-send', error: failure }]);
  assert.equal(session.phase, 'offline');
  assert.ok(timers.pending.has(session.reconnectTimer));
  send.mock.restore();
  timers.run(session.reconnectTimer);
  session.ws.open();
  session.receiveState({ ...baseline, seq: 1, coverage: { server: '1:0:server' } });
  const labelAt = session.lattice.toFrame().nodes[0].labelAt;
  assert.deepEqual(structureFrames(session.ws).map(withoutFrameId), [flushFrame({
    nodes: [{ id: 'root', label: 'Retained after failure', labelAt }], edges: [], kinds: [],
  }, session.actor)]);
});
