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
  assert.throws(() => session.dispatch({ kind: 'CreateNode', id: null, prerequisites: [] }, { captureFailures: true }), { message: 'malformed node entry' });
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
  const receipt = session.dispatch({ kind: 'CreateNode', id: 'child', label: 'Child', prerequisites: ['root'] }, { captureFailures: true });
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
  const receipt = session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Renamed' }, { captureFailures: true });
  await Promise.resolve();
  assert.ok(receipt);
  assert.deepEqual(failures, [{ operation: 'roadmap-sync-persist', error: storageError }]);
  assert.equal(session.durabilityAtRisk, true);
});

test('legacy dispatch keeps post-apply boundary exceptions when failure capture is not requested', () => {
  const failures = [];
  const session = sessionWith({ notify: () => { throw new Error('legacy callback'); }, reportFailure: (operation) => failures.push(operation) });
  assert.throws(() => session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Renamed' }), { message: 'legacy callback' });
  assert.deepEqual(failures, []);
  assert.equal(session.undoStack.length, 1);
});

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
    structureInFlight: 0, progressInFlight: 0, refused: null, receiptVersion: 0 }]);
  assert.equal(session.statusSnapshot(), seen[0]);
  assert.equal(Object.isFrozen(seen[0]), true);
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Local' });
  assert.deepEqual(seen.at(-1), { ...seen[0], structurePending: 1, structureInFlight: 1 });
  session.markProgress('root', 'complete');
  assert.deepEqual(seen.at(-1), { ...seen[0], structurePending: 1, progressPending: 1, structureInFlight: 1, progressInFlight: 1 });
  session.receiveAck({ frameId: [...session.inFlight.keys()][0] });
  assert.deepEqual(seen.at(-1), { ...seen[0], progressPending: 1, progressInFlight: 1 });
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

test('structure discard durably replaces one lane, preserves projection and progress, and invalidates receipts', async (t) => {
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
  assert.deepEqual(projections, [['Local']]);
  session.connect();
  session.ws.open();
  assert.deepEqual(session.ws.frames[0], { t: 'subscribe', treeId: 'tree', lastSeq: 0, vector: {} });
  session.receiveState({ ...server, seq: 1 });
  assert.deepEqual(projections, [['Local'], ['Root']]);
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
  assert.deepEqual(overlays, []);
  assert.equal(session.ready, false);
  session.receiveState({ nodes: [], edges: [], kinds: [], seq: 1 });
  assert.equal(session.ready, false);
  session.receiveProgressGraft({ marks: [] });
  assert.equal(session.ready, true);
  assert.deepEqual(overlays, [[]]);
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
    structureInFlight: 0, progressInFlight: 0, refused: null, receiptVersion: 0 });
  assert.equal(session.statusHandlers.size, 0);
});
