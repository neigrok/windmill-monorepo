import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncSession } from '../../../../src/products/roadmap/sync/SyncSession.js';
import { BuildRetirement } from '../../../../src/products/roadmap/sync/retirement.js';
import { SyncStore } from '../../../../src/products/roadmap/sync/SyncStore.js';

class Timers {
  constructor() {
    this.pending = new Map();
    this.next = 0;
  }
  setTimeout(callback) { this.pending.set(++this.next, callback); return this.next; }
  clearTimeout(id) { this.pending.delete(id); }
  setInterval(callback) { return this.setTimeout(callback); }
  clearInterval(id) { this.pending.delete(id); }
  runReconnects() {
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const callback of due) callback();
  }
}

class Socket extends EventTarget {
  static OPEN = 1;
  static made = [];
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    Socket.made.push(this);
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  receive(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

function memoryStore() {
  const store = {
    record: null,
    load: async () => structuredClone(store.record),
    save: async (treeId, value) => { store.record = structuredClone(value); return { status: 'saved' }; },
    requestPersistent: async () => true,
    holdsOnDevice: async () => true,
  };
  return store;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const labelsIn = (frame) => Object.fromEntries((frame?.nodes ?? []).map((node) => [node.id, node.label]));
const GRAFT = { t: 'subgraph', intent: 'delta', seq: 1, reach: 'writer', nodes: [{ id: 'root', createdAt: '1:0:server', label: 'Root', labelAt: '1:0:server' }], edges: [], kinds: [] };

test('a retired build keeps every unsent write in the old store, sends nothing more and never reconnects', async (t) => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = original; });
  const probes = [];
  const reports = [];
  const events = [];
  const retirement = new BuildRetirement({
    page: { reloadMark: () => Date.now(), markReload: () => true },
    fetch: async (url, init) => {
      probes.push(url);
      return new Response(JSON.stringify({ error: 'This version of the app can no longer save; update it.', code: 'client-update-required' }), { status: 410 });
    },
    events: { track: (name, props) => events.push(props) },
    online: () => true,
    timers: new Timers(),
  });
  const store = memoryStore();
  const timers = new Timers();
  const session = new SyncSession({ url: 'ws://localhost:8088/v1/socket', treeId: 'tree', title: 'Tree', registry: null, store, timers, retirement,
    reportFailure: (...report) => reports.push(report) });
  await session.start();
  const live = Socket.made.at(-1);
  live.open();
  live.receive(GRAFT);
  live.receive({ t: 'progress', intent: 'graft', marks: [] });
  assert.equal(session.phase, 'live');

  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Sent and never answered' });
  assert.deepEqual(live.sent.filter((frame) => frame.t === 'subgraph').map((frame) => labelsIn(frame).root), ['Sent and never answered']);
  live.close();
  assert.deepEqual(probes, [], 'a socket that opened and closed says nothing of the build');

  timers.runReconnects();
  const refused = Socket.made.at(-1);
  assert.notEqual(refused, live);
  refused.close();
  await settle();
  assert.deepEqual(probes, ['http://localhost:8088/v1/socket']);
  assert.equal(retirement.retired, 'socket');
  assert.deepEqual({ phase: session.phase, socket: session.ws, timers: timers.pending.size, inFlight: session.inFlight.size },
    { phase: 'offline', socket: null, timers: 0, inFlight: 0 });

  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Written while retired' });
  session.markProgress('root', 'complete');
  await settle();
  timers.runReconnects();
  assert.equal(Socket.made.at(-1), refused, 'no socket after retirement');
  assert.deepEqual(live.sent.filter((frame) => frame.t === 'subgraph').length, 1);
  assert.deepEqual(store.record.frame.nodes.map(({ id, label }) => ({ id, label })), [{ id: 'root', label: 'Written while retired' }]);
  assert.deepEqual(store.record.confirmed.structure.nodes.map(({ id, label }) => ({ id, label })), [{ id: 'root', label: 'Root' }]);
  assert.deepEqual(store.record.progress.marks.map(({ node, status }) => ({ node, status })), [{ node: 'root', status: 'complete' }]);
  assert.equal(Object.keys(store.record.gestures.structure).length, 2);
  session.close();

  const reloaded = new SyncSession({ url: 'ws://localhost:8088/v1/socket', treeId: 'tree', title: 'Tree', registry: null, store, timers, retirement,
    reportFailure: (...report) => reports.push(report) });
  await reloaded.start();
  assert.equal(Socket.made.at(-1), refused, 'a session the retired page starts opens no socket');
  assert.deepEqual({ label: reloaded.lattice.toTreeData().nodes[0].label, edits: reloaded.pendingEditCount(), marks: reloaded.pendingProgressCount(), phase: reloaded.phase },
    { label: 'Written while retired', edits: 2, marks: 1, phase: 'offline' });
  reloaded.close();
  assert.deepEqual(reports, []);
  assert.deepEqual(events, [{ step: 'detected', door: 'socket' }, { step: 'reload', door: 'socket', outcome: 'suppressed' }]);
});

// A page at rest, hidden and holding nothing, that keeps its mark: only the saves can stop its reload.
function restingPage() {
  return { reloads: 0, holdsWork: () => false, resting: () => true, watch: () => () => {}, reloadMark: () => null, markReload: () => true,
    reload() { this.reloads += 1; } };
}

async function retiredWith(t, store) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = original; });
  const page = restingPage();
  const events = [];
  const reports = [];
  const timers = new Timers();
  const retirement = new BuildRetirement({ page, timers, online: () => true, events: { track: (name, props) => events.push(props.outcome ?? props.step) },
    fetch: async () => new Response(JSON.stringify({ error: 'Update.', code: 'client-update-required' }), { status: 410 }) });
  const session = new SyncSession({ url: 'ws://localhost:8088/v1/socket', treeId: 'tree', title: 'Tree', registry: null, store, timers, retirement,
    reportFailure: (operation) => reports.push(operation) });
  t.after(() => session.close());
  await session.start();
  const live = Socket.made.at(-1);
  live.open();
  live.receive(GRAFT);
  live.receive({ t: 'progress', intent: 'graft', marks: [] });
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Unsent' });
  live.close();
  timers.runReconnects();
  Socket.made.at(-1).close();
  for (let turn = 0; turn < 10; turn += 1) await settle();
  return { session, page, retirement, events, reports };
}

test('a retired page whose save failed keeps its only copy of an unsent edit: it stays offline instead of reloading', async (t) => {
  const store = { ...memoryStore(), save: async () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); } };
  const { session, page, retirement, events, reports } = await retiredWith(t, store);
  assert.deepEqual({ retired: retirement.retired, reloads: page.reloads, unsent: session.pendingEditCount(), phase: session.phase },
    { retired: 'socket', reloads: 0, unsent: 1, phase: 'offline' });
  assert.deepEqual(events, ['detected', 'suppressed']);
  assert.ok(reports.length > 0 && reports.every((operation) => operation === 'roadmap-sync-persist'));
});

test('a retired page whose browser keeps the store in page memory alone stays offline instead of reloading', async (t) => {
  const store = new SyncStore();
  const { session, page, events } = await retiredWith(t, store);
  assert.deepEqual({ onDevice: await store.holdsOnDevice(), reloads: page.reloads, unsent: session.pendingEditCount() },
    { onDevice: false, reloads: 0, unsent: 1 });
  assert.deepEqual(events, ['detected', 'suppressed']);
});

test('a retired page whose saves reached the device reloads', async (t) => {
  const { page, events } = await retiredWith(t, memoryStore());
  assert.equal(page.reloads, 1);
  assert.deepEqual(events, ['detected', 'ran']);
});
