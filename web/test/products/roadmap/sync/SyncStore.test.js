import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { SyncStore } from '../../../../src/products/roadmap/sync/SyncStore.js';
import { SyncSession } from '../../../../src/products/roadmap/sync/SyncSession.js';
import { TreeLattice } from '../../../../src/products/roadmap/sync/lattice.js';

const baseline = { nodes: [{ id: 'root', createdAt: '1:0:server', label: 'Root', labelAt: '1:0:server' }], edges: [], kinds: [] };
const progress = { marks: [{ node: 'root', status: 'none', at: '2:0:server', markedAt: 2 }] };
const changed = (label, stamp = '3:0:tab') => {
  const lattice = new TreeLattice();
  lattice.join(baseline);
  lattice.join({ nodes: [{ id: 'root', label, labelAt: stamp }] });
  return lattice.toFrame();
};
const value = () => ({ frame: changed('Local'), progress: { marks: [{ node: 'root', status: 'complete', at: '4:0:tab' }] },
  lastSeq: 1, epochs: { structure: 0, progress: 0 }, confirmed: { structure: baseline, progress } });

class Channel {
  static channels = new Set();
  static pending = [];
  constructor(name) { this.name = name; Channel.channels.add(this); }
  postMessage(data) {
    for (const peer of Channel.channels) {
      if (peer !== this && peer.name === this.name) Channel.pending.push(() => peer.onmessage?.({ data: structuredClone(data) }));
    }
  }
  close() { Channel.channels.delete(this); }
  static deliver() { for (const run of Channel.pending.splice(0)) run(); }
}

class Socket extends EventTarget {
  static OPEN = 1;
  constructor() { super(); this.readyState = 0; this.frames = []; }
  send(text) { this.frames.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

function environment(t) {
  for (const [key, replacement] of Object.entries({ indexedDB: new IDBFactory(), BroadcastChannel: Channel,
    WebSocket: Socket, window: new EventTarget(), document: new EventTarget() })) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: replacement });
    t.after(() => {
      if (prior) Object.defineProperty(globalThis, key, prior);
      else delete globalThis[key];
    });
  }
  Channel.channels.clear();
  Channel.pending = [];
  t.mock.method(globalThis, 'setInterval', () => 0);
  t.mock.method(globalThis, 'clearInterval', () => {});
  const stores = [];
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) session.close();
    for (const store of stores) {
      store.channel?.close();
      (await store.db()).close();
    }
  });
  return {
    store() { const store = new SyncStore(); stores.push(store); return store; },
    async session(store) {
      const session = new SyncSession({ treeId: 'tree', store, registry: null, reportFailure: (operation, error) => {
        throw new Error(`${operation}: ${error.stack}`);
      } });
      sessions.push(session);
      await session.start();
      return session;
    },
  };
}

const settle = async (stores = []) => {
  for (let round = 0; round < 12; round += 1) {
    await Promise.all(stores.map((store) => store.chain));
    await new Promise((resolve) => setImmediate(resolve));
  }
};

for (const lane of ['structure', 'progress']) {
  test(`real IndexedDB replaces only ${lane}, rejects stale saves and keeps the confirmed offline projection`, async (t) => {
    const env = environment(t);
    const first = env.store();
    const peer = env.store();
    await first.save('tree', value());
    const old = await peer.load('tree');
    const discarded = await first.replaceLane('tree', lane, 0);
    assert.equal(discarded.status, 'replaced');
    const expected = value();
    expected.epochs[lane] = 1;
    if (lane === 'structure') { expected.frame = baseline; expected.lastSeq = 0; }
    else expected.progress = progress;
    assert.deepEqual(discarded.value, expected);
    const stale = await peer.save('tree', old);
    assert.deepEqual(stale, { status: 'stale', staleLanes: [lane], value: expected });
    assert.deepEqual(await env.store().load('tree'), expected);
    let sent = 0;
    const checked = await peer.withEpoch('tree', lane, 0, () => { sent += 1; });
    assert.deepEqual(checked, { status: 'stale', staleLanes: [lane], value: expected });
    assert.equal(sent, 0);
  });
}

test('legacy projected records migrate losslessly and cannot discard an unknown confirmed baseline', async (t) => {
  const env = environment(t);
  const store = env.store();
  const legacy = { frame: changed('Legacy pending'), progress, lastSeq: 19 };
  const db = await store.db();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('trees', 'readwrite');
    transaction.objectStore('trees').put(legacy, 'tree');
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  const expected = { ...legacy, epochs: { structure: 0, progress: 0 }, confirmed: { structure: null, progress: null } };
  assert.deepEqual(await store.load('tree'), expected);
  assert.deepEqual(await store.replaceLane('tree', 'structure', 0), { status: 'unavailable', value: expected });
  assert.deepEqual(await store.load('tree'), expected);
  const session = await env.session(store);
  assert.equal(session.lattice.toTreeData().nodes[0].label, 'Legacy pending');
  assert.equal(session.ready, true);
});

test('read-only epoch validation and wire send serialize against an atomic lane replacement', async (t) => {
  const env = environment(t);
  const store = env.store();
  const other = env.store();
  await store.save('tree', value());
  const order = [];
  await other.withEpoch('tree', 'structure', 0, () => order.push('sent-before-discard'));
  await store.replaceLane('tree', 'structure', 0);
  await other.withEpoch('tree', 'structure', 0, () => order.push('stale-send'));
  await other.withEpoch('tree', 'structure', 1, () => order.push('sent-current'));
  assert.deepEqual(order, ['sent-before-discard', 'sent-current']);
});

test('a real session discards to its exact server baseline and reloads offline before any fresh server answer', async (t) => {
  const env = environment(t);
  const store = env.store();
  const session = await env.session(store);
  session.ws.open();
  session.receiveState({ ...baseline, seq: 1 });
  session.receiveProgressGraft(progress);
  await settle([store]);
  const projections = [];
  session.onTreeChanged((tree) => projections.push(tree.nodes.map((node) => node.label)));
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Refused' });
  session.markProgress('root', 'complete');
  await settle([store]);
  const preservedProgress = session.progress.toFrame();
  const frameId = [...session.inFlight.keys()].at(-1);
  assert.ok(frameId);
  session.receiveReject({ t: 'reject', frameId, code: 'server-error' });
  session.online = false;
  session.ws.close();
  assert.equal(await session.discard(), true);
  assert.deepEqual(projections, [['Refused'], ['Root'], ['Root']]);
  const persisted = await store.load('tree');
  assert.deepEqual(persisted.frame, baseline);
  assert.deepEqual(persisted.progress, preservedProgress);
  const reloaded = await env.session(env.store());
  assert.deepEqual(reloaded.lattice.toTreeData().nodes.map(({ id, label }) => ({ id, label })), [{ id: 'root', label: 'Root' }]);
  assert.deepEqual(reloaded.progress.toFrame(), preservedProgress);
  assert.equal(reloaded.ready, true);
  session.connect();
  session.ws.open();
  session.receiveState({ ...baseline, seq: 1 });
  assert.deepEqual(projections, [['Refused'], ['Root'], ['Root'], ['Root']]);
});

for (const lane of ['structure', 'progress']) {
  test(`a live peer cannot resend discarded ${lane} before BroadcastChannel delivery, including on reconnect`, async (t) => {
    const env = environment(t);
    const ownerStore = env.store();
    const peerStore = env.store();
    await ownerStore.save('tree', value());
    const peer = await env.session(peerStore);
    peer.ws.open();
    peer.receiveState({ ...baseline, seq: 1 });
    peer.receiveProgressGraft(progress);
    await settle([peerStore]);
    const oldSocket = peer.ws;
    oldSocket.frames = [];
    await ownerStore.replaceLane('tree', lane, 0);
    assert.ok(Channel.pending.length > 0);
    if (lane === 'structure') peer.flush();
    else peer.flushProgress();
    await settle([peerStore]);
    assert.deepEqual(oldSocket.frames, []);
    assert.equal(peer.epochs[lane], 1);
    assert.equal(peer.ready, false);
    peer.connect();
    peer.ws.open();
    peer.receiveState({ ...baseline, seq: 1 });
    peer.receiveProgressGraft(progress);
    await settle([peerStore]);
    const forbiddenType = lane === 'structure' ? 'subgraph' : 'progress';
    assert.deepEqual(peer.ws.frames.filter((frame) => frame.t === forbiddenType), []);
    assert.deepEqual((await peerStore.load('tree'))[lane === 'structure' ? 'frame' : 'progress'], lane === 'structure' ? baseline : progress);
  });
}

test('BroadcastChannel invalidates a live peer without a save or flush and releases its subscription on close', async (t) => {
  const env = environment(t);
  const first = env.store();
  const peerStore = env.store();
  await first.save('tree', value());
  const peer = await env.session(peerStore);
  await first.replaceLane('tree', 'structure', 0);
  Channel.deliver();
  await settle([peerStore]);
  assert.equal(peer.epochs.structure, 1);
  assert.deepEqual(peer.lattice.toFrame(), baseline);
  assert.equal(peer.receiptVersion, 1);
  peer.close();
  assert.equal(peerStore.listeners.size, 0);
  assert.equal(peerStore.channel, null);
});

test('an acknowledgement confirms the exact sent value even when a later local value already won', async (t) => {
  const env = environment(t);
  const store = env.store();
  const session = await env.session(store);
  session.ws.open();
  session.receiveState({ ...baseline, seq: 1 });
  session.receiveProgressGraft(progress);
  await settle([store]);
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Accepted' });
  session.markProgress('root', 'complete');
  await settle([store]);
  const structureAck = [...session.inFlight.keys()].at(-1);
  const progressAck = [...session.progressInFlight.keys()].at(-1);
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Later refused' });
  session.markProgress('root', 'none');
  await settle([store]);
  session.receiveAck({ frameId: structureAck });
  session.receiveProgressAck({ frameId: progressAck });
  await settle([store]);
  const saved = await store.load('tree');
  assert.equal(saved.confirmed.structure.nodes[0].label, 'Accepted');
  assert.equal(saved.confirmed.progress.marks[0].status, 'complete');
  assert.equal(saved.frame.nodes[0].label, 'Later refused');
  assert.equal(saved.progress.marks[0].status, 'none');
  session.receiveReject({ frameId: [...session.inFlight.keys()].at(-1), code: 'bad-frame' });
  assert.equal(await session.discard(), true);
  assert.equal((await store.load('tree')).frame.nodes[0].label, 'Accepted');
});

test('save rejects storage/validation failures without poisoning subsequent saves', async (t) => {
  const env = environment(t);
  const store = env.store();
  await assert.rejects(store.save('tree', { frame: { nodes: [{ label: 'missing id' }] } }), { message: 'malformed node entry' });
  assert.equal((await store.save('tree', value())).status, 'saved');
  assert.deepEqual(await store.load('tree'), value());
});

test('overlapping stale saves and discard transactions cannot resurrect the discarded lane in either order', async (t) => {
  const env = environment(t);
  for (const order of ['save-first', 'discard-first']) {
    const writer = env.store();
    const discarder = env.store();
    await writer.save(order, value());
    const old = await writer.load(order);
    if (order === 'save-first') {
      await Promise.all([writer.save(order, old), discarder.replaceLane(order, 'structure', 0)]);
    } else {
      await Promise.all([discarder.replaceLane(order, 'structure', 0), writer.save(order, old)]);
    }
    const stored = await discarder.load(order);
    assert.deepEqual(stored.frame, baseline);
    assert.equal(stored.epochs.structure, 1);
    assert.deepEqual(stored.progress, value().progress);
  }
});

test('loading a newer epoch never blesses a previously captured unversioned snapshot', async (t) => {
  const env = environment(t);
  const store = env.store();
  await store.save('tree', value());
  const old = await store.load('tree');
  const unversioned = { frame: old.frame, progress: old.progress, lastSeq: old.lastSeq };
  await store.replaceLane('tree', 'structure', 0);
  const current = await store.load('tree');
  assert.deepEqual(await store.save('tree', unversioned), { status: 'stale', staleLanes: ['structure'], value: current });
});

test('an epoch notification failure cannot turn a committed discard into a failed transaction', async (t) => {
  const env = environment(t);
  const store = env.store();
  await store.save('tree', value());
  const error = new Error('channel unavailable');
  t.mock.method(store, 'publishEpoch', () => { throw error; });
  const result = await store.replaceLane('tree', 'structure', 0);
  assert.equal(result.status, 'replaced');
  assert.equal(result.notificationError, error);
  assert.deepEqual((await store.load('tree')).frame, baseline);
});

test('a server-confirmed progress reset supersedes completion by HLC and survives a refused later mark', async (t) => {
  const env = environment(t);
  const store = env.store();
  const session = await env.session(store);
  session.ws.open();
  session.receiveState({ ...baseline, seq: 1 });
  session.receiveProgressGraft({ marks: [{ node: 'root', status: 'complete', at: '2:0:server' }] });
  session.receiveProgress({ marks: [{ node: 'root', status: 'none', at: '3:0:server' }] });
  session.markProgress('root', 'complete');
  await settle([store]);
  session.receiveReject({ frameId: [...session.progressInFlight.keys()].at(-1), code: 'server-error' });
  assert.equal(await session.discard(), true);
  assert.deepEqual((await store.load('tree')).progress, { marks: [{ node: 'root', status: 'none', at: '3:0:server' }] });
});

test('progress Undo persists during a structure discard transaction and before the server rebaseline', async (t) => {
  const env = environment(t);
  const store = env.store();
  const session = await env.session(store);
  session.ws.open();
  session.receiveState({ ...baseline, seq: 1 });
  session.receiveProgressGraft({ marks: [{ node: 'root', status: 'complete', at: '2:0:server' }] });
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Refused' });
  await settle([store]);
  session.receiveReject({ frameId: [...session.inFlight.keys()].at(-1), code: 'server-error' });
  const replace = store.replaceLane.bind(store);
  let finish;
  t.mock.method(store, 'replaceLane', (...args) => new Promise((resolve) => {
    finish = () => resolve(replace(...args));
  }));
  const discarding = session.discard();
  session.markProgress('root', 'none');
  assert.equal(session.discardPending, true);
  assert.equal(session.progress.overlay().completed.size, 0);
  assert.equal((await store.load('tree')).progress.marks[0].status, 'complete');
  finish();
  assert.equal(await discarding, true);
  assert.equal(session.ready, false);
  const saved = await store.load('tree');
  assert.deepEqual(saved.frame, baseline);
  assert.equal(saved.progress.marks[0].status, 'none');
  assert.equal(session.progress.deltaSince(session.ackedProgressVector).marks.length, 1);
  session.markProgress('root', 'complete');
  await settle([store]);
  assert.equal((await store.load('tree')).progress.marks[0].status, 'complete');
});

test('BroadcastChannel construction failure reports once and falls back to transaction epoch checks', async (t) => {
  const env = environment(t);
  const store = env.store();
  const peer = env.store();
  await peer.save('tree', value());
  const failure = new Error('channel unavailable');
  globalThis.BroadcastChannel = class { constructor() { throw failure; } };
  const reports = [];
  const session = new SyncSession({ treeId: 'tree', store, registry: null,
    reportFailure: (operation, error) => reports.push({ operation, error }) });
  t.after(() => session.close());
  await session.start();
  assert.deepEqual(reports, [{ operation: 'roadmap-sync-notify', error: failure }]);
  assert.equal(store.listeners.size, 0);
  session.ws.open();
  session.receiveState({ ...baseline, seq: 1 });
  session.receiveProgressGraft(progress);
  await settle([store]);
  const socket = session.ws;
  socket.frames = [];
  await peer.replaceLane('tree', 'structure', 0);
  session.flush();
  await settle([store]);
  assert.deepEqual(socket.frames, []);
  assert.equal(session.epochs.structure, 1);
  assert.deepEqual(reports, [{ operation: 'roadmap-sync-notify', error: failure }]);
});

test('pending gestures survive reload and repeated edits to one register, then acknowledgements and discard remove only their lane', async (t) => {
  const env = environment(t);
  const store = env.store();
  const session = await env.session(store);
  session.ws.open();
  session.receiveState({ ...baseline, seq: 1 });
  session.receiveProgressGraft(progress);
  session.dispatch({ kind: 'CreateNode', id: 'child', label: 'Child', prerequisites: ['root'] });
  session.dispatch({ kind: 'RenameNode', id: 'child', label: 'First' });
  session.dispatch({ kind: 'RenameNode', id: 'child', label: 'Second' });
  session.markProgress('root', 'complete');
  await settle([store]);
  const saved = await store.load('tree');
  assert.deepEqual(saved.gestures, session.gestures);
  assert.equal(Object.keys(saved.gestures.structure).length, 3);
  const reloaded = await env.session(env.store());
  assert.equal(reloaded.statusSnapshot().structureGestures, 3);
  assert.equal(reloaded.statusSnapshot().progressGestures, 1);
  const first = [...session.inFlight.keys()][0];
  session.receiveAck({ frameId: first });
  await settle([store]);
  assert.deepEqual((await store.load('tree')).gestures, { structure: Object.fromEntries(Object.entries(saved.gestures.structure).slice(1)), progress: saved.gestures.progress });
  session.receiveReject({ frameId: [...session.inFlight.keys()].at(-1), code: 'bad-frame' });
  assert.equal(await session.discard(), true);
  assert.deepEqual((await store.load('tree')).gestures, { structure: {}, progress: saved.gestures.progress });
});

function refuseDatabase(t) {
  environment(t);
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open() { throw new DOMException('private refusal', 'SecurityError'); } } });
  t.after(() => Object.defineProperty(globalThis, 'indexedDB', prior));
  t.mock.method(console, 'warn', () => {});
  const reports = [];
  return {
    reports,
    async session(treeId) {
      const session = new SyncSession({ treeId, store: new SyncStore(), registry: null, reportFailure: (operation) => reports.push(operation) });
      t.after(() => session.close());
      await session.start();
      session.ws.open();
      return session;
    },
  };
}

test('a refused database still carries a write to the server, reports nothing, and keeps it for this document only', async (t) => {
  const { reports, session: open } = refuseDatabase(t);
  const session = await open('refused-send');
  session.receiveState({ ...baseline, seq: 1 });
  session.receiveProgressGraft({ marks: [] });
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Sent' });
  session.markProgress('root', 'complete');
  await settle([session.store]);
  assert.deepEqual(session.ws.frames.filter(({ t }) => t !== 'subscribe').map(({ t, nodes, marks }) => [t, nodes?.[0].label ?? marks[0].status]), [['subgraph', 'Sent'], ['progress', 'complete']]);
  assert.deepEqual(reports, []);
  assert.equal(session.statusSnapshot().refused, null);
  assert.equal(await session.store.holdsOnDevice(), false);
  assert.equal(await session.store.requestPersistent(), false);
});

test('an offline write under a refused database outlives its session in this document and flushes on the next', async (t) => {
  const { reports, session: open } = refuseDatabase(t);
  const first = await open('refused-offline');
  first.receiveState({ ...baseline, seq: 1 });
  first.receiveProgressGraft({ marks: [] });
  first.ws.close();
  first.dispatch({ kind: 'RenameNode', id: 'root', label: 'Unsent' });
  await settle([first.store]);
  first.close();
  const second = await open('refused-offline');
  assert.equal(second.lattice.toTreeData().nodes[0].label, 'Unsent');
  second.receiveState({ ...baseline, seq: 1 });
  await settle([second.store]);
  assert.equal(second.ws.frames.at(-1).nodes.find(({ id }) => id === 'root').label, 'Unsent');
  assert.deepEqual(reports, []);
});

test('a refused database still discards: the refused write goes and the confirmed lane stands', async (t) => {
  const { session: open } = refuseDatabase(t);
  const session = await open('refused-discard');
  session.receiveState({ ...baseline, seq: 1 });
  session.receiveProgressGraft({ marks: [] });
  await settle([session.store]);
  session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Refused' });
  await settle([session.store]);
  session.receiveReject({ t: 'reject', frameId: [...session.inFlight.keys()].at(-1), code: 'server-error' });
  assert.equal(await session.discard(), true);
  assert.equal(session.lattice.toTreeData().nodes[0].label, 'Root');
});

test('a database that opens after refusing takes back what the document held', async (t) => {
  const env = environment(t);
  const real = globalThis.indexedDB;
  t.mock.method(console, 'warn', () => {});
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value: { open() { throw new DOMException('private refusal', 'SecurityError'); } } });
  await new SyncStore().save('returned', value());
  globalThis.indexedDB = real;
  const store = env.store();
  assert.deepEqual((await store.load('returned')).frame, value().frame);
  assert.deepEqual((await env.store().load('returned')).frame, value().frame);
});

async function liveTab(env, store) {
  const session = await env.session(store);
  session.ws.open();
  session.receiveState({ ...baseline, seq: 1 });
  session.receiveProgressGraft(progress);
  await settle([store]);
  return session;
}

const labels = (session) => Object.fromEntries(session.lattice.toTreeData().nodes.map(({ id, label }) => [id, label]));

test('a discard in one tab takes only what it showed: the other tab keeps its unsent writes, stores them and sends them', async (t) => {
  const env = environment(t);
  const storeA = env.store();
  const storeB = env.store();
  const tabA = await liveTab(env, storeA);
  const tabB = await liveTab(env, storeB);
  tabB.ws.close();
  tabB.dispatch({ kind: 'CreateNode', id: 'bs', label: 'B work', prerequisites: ['root'] });
  tabB.markProgress('root', 'complete');
  await settle([storeB]);
  tabA.dispatch({ kind: 'RenameNode', id: 'root', label: 'A refused' });
  await settle([storeA]);
  tabA.receiveReject({ t: 'reject', frameId: [...tabA.inFlight.keys()].at(-1), code: 'server-error' });
  assert.equal(tabA.statusSnapshot().structureGestures, 1);
  assert.equal(await tabA.discard(), true);
  assert.deepEqual(labels(tabA), { root: 'Root', bs: 'B work' });
  const stored = await env.store().load('tree');
  assert.deepEqual(stored.frame.nodes.map(({ id, label }) => [id, label]), [['root', 'Root'], ['bs', 'B work']]);
  Channel.deliver();
  await settle([storeA, storeB]);
  assert.equal(tabB.epochs.structure, 1);
  assert.deepEqual(labels(tabB), { root: 'Root', bs: 'B work' });
  assert.equal(tabB.progress.overlay().completed.has('root'), true);
  assert.equal(tabB.pendingEditCount(), 1);
  tabB.connect();
  tabB.ws.open();
  tabB.receiveState({ ...baseline, seq: 1 });
  await settle([storeB]);
  const flushed = tabB.ws.frames.filter(({ t }) => t === 'subgraph').at(-1);
  assert.deepEqual(flushed.nodes.filter(({ id }) => id === 'bs').map(({ label }) => label), ['B work']);
  assert.equal(flushed.nodes.some(({ label }) => label === 'A refused'), false);
});

test('the same tab hears about a discard through its stale save and still keeps its own write', async (t) => {
  const env = environment(t);
  const storeA = env.store();
  const storeB = env.store();
  const tabA = await liveTab(env, storeA);
  const tabB = await liveTab(env, storeB);
  tabA.dispatch({ kind: 'RenameNode', id: 'root', label: 'A refused' });
  await settle([storeA]);
  tabA.receiveReject({ t: 'reject', frameId: [...tabA.inFlight.keys()].at(-1), code: 'server-error' });
  assert.equal(await tabA.discard(), true);
  tabB.ws.close();
  tabB.dispatch({ kind: 'CreateNode', id: 'bs', label: 'B after the discard', prerequisites: ['root'] });
  await settle([storeB]);
  assert.equal(tabB.epochs.structure, 1);
  assert.deepEqual(labels(tabB), { root: 'Root', bs: 'B after the discard' });
  assert.deepEqual((await env.store().load('tree')).frame.nodes.map(({ id }) => id), ['root', 'bs']);
});

test('a discard scoped to what one writer showed keeps the rest of the lane and its gestures', async (t) => {
  const env = environment(t);
  const store = env.store();
  const frame = changed('Mine', '5:0:mine');
  frame.nodes.push({ id: 'other', createdAt: '6:0:other', label: 'Theirs', labelAt: '6:0:other' });
  await store.save('tree', { ...value(), frame, progress: { marks: [] }, gestures: { structure: {}, progress: {} } });
  const shown = { [JSON.stringify(['nodes', 'root', 'labelAt'])]: '5:0:mine' };
  const { value: replaced } = await store.replaceLane('tree', 'structure', 0, shown);
  assert.deepEqual(replaced.frame.nodes, [
    { id: 'root', createdAt: '1:0:server', label: 'Root', labelAt: '1:0:server' },
    { id: 'other', createdAt: '6:0:other', label: 'Theirs', labelAt: '6:0:other' },
  ]);
  assert.deepEqual(replaced.gestures.structure, { '6:0:other': {
    [JSON.stringify(['nodes', 'other', 'createdAt'])]: '6:0:other',
    [JSON.stringify(['nodes', 'other', 'labelAt'])]: '6:0:other',
  } });
});

test('a stored lane the store cannot read gives way to what the writer holds', async (t) => {
  const env = environment(t);
  const store = env.store();
  const db = await store.db();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('trees', 'readwrite');
    transaction.objectStore('trees').put({ frame: { edges: 7 }, progress: { marks: 'private' } }, 'tree');
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  const result = await store.save('tree', value());
  assert.equal(result.status, 'saved');
  assert.deepEqual(result.value.frame, value().frame);
});

test('a save made while leaving lands from memory, in one call, joined with the record the store last read', async (t) => {
  const env = environment(t);
  const store = env.store();
  const other = env.store();
  await store.load('tree');
  await other.save('tree', value());
  await store.load('tree');
  const leaving = changed('Left', '9:0:leaving');
  const started = store.saveWhileLeaving('tree', { frame: leaving, lastSeq: 2, epochs: { structure: 0, progress: 0 }, confirmed: { structure: baseline } });
  const stored = await other.load('tree');
  await started;
  assert.deepEqual(stored.frame, leaving);
  assert.deepEqual(stored.progress, value().progress);
  assert.deepEqual(stored.confirmed, value().confirmed);
  assert.equal(stored.lastSeq, 2);
});

test('with no record read yet, a save while leaving falls back to the read-first save', async (t) => {
  const env = environment(t);
  const store = env.store();
  const other = env.store();
  await other.save('tree', value());
  const result = await store.saveWhileLeaving('tree', { frame: changed('Left', '9:0:leaving'), epochs: { structure: 0, progress: 0 } });
  assert.equal(result.status, 'saved');
  assert.deepEqual((await other.load('tree')).progress, value().progress);
});

test('a hold reads the record ahead, so leaving keeps what another tab stored before it began', async (t) => {
  const env = environment(t);
  const storeA = env.store();
  const tabA = await liveTab(env, storeA);
  const other = env.store();
  const stored = await other.load('tree');
  const peer = new TreeLattice();
  peer.join(stored.frame);
  peer.join({ nodes: [{ id: 'closed', createdAt: '8:0:closed', label: 'From a closed tab', labelAt: '8:0:closed' }] });
  await other.save('tree', { ...stored, frame: peer.toFrame() });
  tabA.holdAct(() => {});
  await settle([storeA]);
  await new Promise((resolve) => setImmediate(resolve));
  tabA.ws.readyState = 3;
  tabA.leavePage();
  tabA.dispatch({ kind: 'RenameNode', id: 'root', label: 'Left' });
  await settle([storeA]);
  const after = await env.store().load('tree');
  assert.deepEqual(after.frame.nodes.map(({ id, label }) => [id, label]), [['root', 'Left'], ['closed', 'From a closed tab']]);
});

test('a discard that finds another tab got there first takes nothing of its own: its writes stay and the refused card can come back', async (t) => {
  const env = environment(t);
  const storeA = env.store();
  const storeB = env.store();
  const tabA = await liveTab(env, storeA);
  const tabB = await liveTab(env, storeB);
  tabA.dispatch({ kind: 'RenameNode', id: 'root', label: 'A refused' });
  tabB.dispatch({ kind: 'CreateNode', id: 'bs', label: 'B refused', prerequisites: ['root'] });
  await settle([storeA, storeB]);
  tabA.receiveReject({ t: 'reject', frameId: [...tabA.inFlight.keys()].at(-1), code: 'server-error' });
  tabB.receiveReject({ t: 'reject', frameId: [...tabB.inFlight.keys()].at(-1), code: 'server-error' });
  assert.equal(await tabB.discard(), true);
  assert.equal(await tabA.discard(), false);
  Channel.deliver();
  await settle([storeA, storeB]);
  assert.equal(labels(tabA).root, 'A refused');
  assert.equal(tabA.pendingEditCount(), 1);
});


test('durable deletion waits for commit and rejects an abort after the delete request succeeds', async (t) => {
  const env = environment(t);
  const store = env.store();
  await store.save('tree', value());
  const db = await store.db();
  const transaction = db.transaction.bind(db);
  t.mock.method(db, 'transaction', (...args) => {
    const txn = transaction(...args);
    const objectStore = txn.objectStore.bind(txn);
    txn.objectStore = (...names) => {
      const rows = objectStore(...names);
      const remove = rows.delete.bind(rows);
      rows.delete = (...keys) => {
        const request = remove(...keys);
        request.addEventListener('success', () => txn.abort());
        return request;
      };
      return rows;
    };
    return txn;
  });
  await assert.rejects(store.clear('tree', { durable: true }));
  db.transaction.mock.restore();
  assert.deepEqual(await store.load('tree'), value());
  await store.clear('tree', { durable: true });
  assert.deepEqual(await store.treeIds({ durable: true }), []);
});

test('durable cleanup never substitutes the document fallback for an unavailable database', async (t) => {
  const store = new SyncStore();
  t.mock.method(store, 'db', async () => { throw new Error('database-unavailable'); });
  await assert.rejects(store.treeIds({ durable: true }), /database-unavailable/);
  await assert.rejects(store.clear('tree', { durable: true }), /database-unavailable/);
});
