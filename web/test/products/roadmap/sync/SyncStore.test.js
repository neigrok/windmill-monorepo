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
      const session = new SyncSession({ trackGestures: true, treeId: 'tree', store, registry: null, reportFailure: (operation, error) => {
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
  const session = new SyncSession({ trackGestures: true, treeId: 'tree', store, registry: null,
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
