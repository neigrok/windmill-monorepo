import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncSession } from '../../../../src/products/roadmap/sync/SyncSession.js';
import { TreeLattice, VersionVector, parseHlc } from '../../../../src/products/roadmap/sync/lattice.js';
import { ProgressLattice } from '../../../../src/products/roadmap/sync/progressLattice.js';
import { frameWrites, pendingRecordCount, unconfirmedStamps, writeStamps } from '../../../../src/products/roadmap/sync/pendingWrites.js';

function mulberry32(seed) {
  return () => {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

class DeliveryTimers {
  constructor() {
    this.now = 1_000_000;
    this.nextId = 0;
    this.pending = new Map();
  }
  setTimeout(callback, delay = 0) {
    const id = ++this.nextId;
    this.pending.set(id, { callback, due: this.now + delay });
    return id;
  }
  clearTimeout(id) { this.pending.delete(id); }
  setInterval() { return ++this.nextId; }
  clearInterval() {}
  advance(milliseconds) {
    this.now += milliseconds;
    const ready = [...this.pending].filter(([, timer]) => timer.due <= this.now);
    for (const [id, timer] of ready) {
      if (!this.pending.delete(id)) continue;
      timer.callback();
    }
  }
}

// Collab's subscribe masks the payload by actor, but coverage describes the entire room.
function serverDelta(lattice, vector) {
  const coverage = VersionVector.fromJSON(vector);
  return frameWrites(lattice.toFrame(), (key, stamp) => !coverage.covers(parseHlc(stamp)));
}

class DeliveryServer {
  constructor(random, timers) {
    this.random = random;
    this.timers = timers;
    this.lattice = new TreeLattice('tree', 'Tree');
    this.lattice.join({ nodes: [{ id: 'root', createdAt: '1:0:server', label: 'Root', labelAt: '1:0:server' }], edges: [], kinds: [] });
    this.progress = new ProgressLattice();
    this.head = 1;
    this.seen = new Map();
    this.queue = [];
    this.acceptAll = false;
    this.verdicts = new Set();
  }
  deliver() {
    let delivered = 0;
    while (this.queue.length) {
      assert.ok(++delivered < 10000, 'reply delivery must terminate');
      const { socket, frame } = this.queue.shift();
      if (socket.readyState !== 1) continue;
      if (frame.t === 'subscribe') {
        socket.message({ t: 'subgraph', intent: 'delta', seq: this.head,
          ...serverDelta(this.lattice, frame.vector), coverage: this.lattice.frontier().toJSON() });
        socket.message({ t: 'progress', intent: 'graft', ...this.progress.toFrame() });
        continue;
      }
      if (frame.t === 'ping') {
        socket.message({ t: 'pong' });
        continue;
      }
      assert.ok(['subgraph', 'progress'].includes(frame.t));
      const poison = (frame.nodes ?? frame.marks).some((row) => (row.id ?? row.node).startsWith('poison-'));
      const draw = this.acceptAll ? 0 : this.random() * 0.9;
      const verdict = poison ? 'poison' : draw < 0.55 ? 'accept' : draw < 0.65 ? 'reject'
        : draw < 0.75 ? 'drop' : draw < 0.8 ? 'skew' : draw < 0.85 ? 'echo-close' : 'close';
      this.verdicts.add(verdict);
      if (verdict === 'drop') continue;
      if (verdict === 'close') {
        socket.close();
        continue;
      }
      if (verdict === 'poison' || verdict === 'reject') {
        socket.message({ t: 'reject', frameId: frame.frameId, code: poison ? 'bad-frame' : 'tree-too-large' });
        continue;
      }
      if (verdict === 'skew') {
        socket.message({ t: 'skew', frameId: frame.frameId, serverNow: this.timers.now - 300001 });
        continue;
      }
      if (frame.t === 'subgraph') {
        if (!this.seen.has(frame.frameId)) {
          this.lattice.join(frame);
          this.head += 1;
          this.seen.set(frame.frameId, this.head);
          socket.message({ ...frame, seq: this.head });
        }
        if (verdict === 'echo-close') {
          socket.close();
          continue;
        }
        socket.message({ t: 'subgraphAck', frameId: frame.frameId, seq: this.seen.get(frame.frameId) });
        continue;
      }
      // Progress upserts compare physical time and counter, without an actor tiebreak.
      for (const mark of frame.marks) {
        const held = this.progress.marks.get(mark.node)?.at;
        const at = parseHlc(mark.at);
        if (held && (held.ms > at.ms || (held.ms === at.ms && held.counter >= at.counter))) continue;
        this.progress.join({ marks: [{ ...mark, markedAt: this.timers.now }] });
      }
      if (verdict === 'echo-close') {
        socket.close();
        continue;
      }
      socket.message({ t: 'progressAck', frameId: frame.frameId });
    }
  }
  peer(socket, node) {
    const stamp = `${++this.timers.now}:0:r_peer`;
    const frame = { t: 'subgraph', intent: 'live', frameId: `peer-${this.head + 1}`, actor: 'r_peer',
      nodes: [{ id: node, description: `Peer ${this.head}`, descriptionAt: stamp }], edges: [], kinds: [] };
    this.lattice.join(frame);
    this.head += 1;
    if (socket?.readyState === 1) socket.message({ ...frame, seq: this.head });
  }
}

// Seeds 1, 7 and 19 fail the accounted-for invariant against the base implementation.
const PERMANENT_SEEDS = [1, 7, 19];

for (const seed of [...new Set([...PERMANENT_SEEDS, ...Array.from({ length: 200 }, (_, index) => index + 1)])]) {
  test(`delivery preserves every register through replies and reloads, seed ${seed}`, async (t) => {
    const random = mulberry32(seed);
    const timers = new DeliveryTimers();
    const server = new DeliveryServer(random, timers);
    const reports = [];
    const actions = new Set();
    let record = null;
    let session;
    let identity = 0;
    let drained = 0;
    let step = -1;
    let serial = 0;
    const label = () => `seed ${seed}, step ${step}`;
    const store = {
      load: async () => structuredClone(record),
      save: async (treeId, value) => { record = structuredClone(value); },
      requestPersistent: async () => true,
    };
    class DeliverySocket extends EventTarget {
      static OPEN = 1;
      constructor() {
        super();
        this.readyState = 0;
        this.frames = new Map();
      }
      send(text) {
        const frame = JSON.parse(text);
        if (frame.frameId) this.frames.set(frame.frameId, frame);
        if (frame.t === 'subgraph' || frame.t === 'progress') {
          const lane = frame.t === 'subgraph' ? 'structure' : 'progress';
          assert.equal(session.rebaselining?.has(lane) ?? false, false, label());
          if (lane === 'progress') {
            for (const mark of frame.marks) assert.deepEqual(Object.keys(mark).sort(), ['at', 'node', 'status'], label());
          }
        }
        server.queue.push({ socket: this, frame });
      }
      open() {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      }
      message(frame) {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
      }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.dispatchEvent(new Event('close'));
      }
    }
    const originals = { WebSocket: globalThis.WebSocket, window: globalThis.window, document: globalThis.document };
    globalThis.WebSocket = DeliverySocket;
    globalThis.window = new EventTarget();
    globalThis.document = new EventTarget();
    globalThis.document.visibilityState = 'visible';
    t.mock.method(Date, 'now', () => timers.now);
    t.mock.method(Math, 'random', random);
    t.mock.method(crypto, 'randomUUID', () => (++identity).toString(16).padStart(8, '0') + '-0000-4000-8000-000000000000');
    // These mocks also let the unchanged base implementation use the same deterministic clock.
    for (const method of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']) {
      t.mock.method(globalThis, method, timers[method].bind(timers));
    }
    t.after(() => {
      session?.close();
      Object.assign(globalThis, originals);
    });
    const reload = async () => {
      const oldActor = session?.actor;
      session?.close();
      session = new SyncSession({ treeId: 'tree', title: 'Tree', registry: null, store, chunkBytes: 1600,
        timers, reportFailure: (operation, error, tags) => reports.push({ operation, error, tags }) });
      session.onDrained(() => { drained += 1; });
      await session.start();
      if (oldActor) assert.notEqual(session.actor, oldActor, label());
      session.ws.open();
      server.deliver();
    };
    const accounted = () => {
      for (const lane of ['structure', 'progress']) {
        const local = lane === 'structure' ? session.lattice : session.progress;
        const confirmed = lane === 'structure' ? session.confirmedStructure : session.confirmedProgress;
        const inFlight = lane === 'structure' ? session.inFlight : session.progressInFlight;
        const carried = [...inFlight.keys()].map((id) => writeStamps(session.ws.frames.get(id)));
        const pending = unconfirmedStamps(writeStamps(local.toFrame()), writeStamps(confirmed.toFrame()));
        for (const [key, stamp] of Object.entries(pending)) {
          assert.ok(carried.some((frame) => frame[key] === stamp) || session.refusals.has(lane)
            || session.resendTimers?.[lane] != null || session.skewTimers?.[lane] != null || session.phase !== 'live',
          `${label()}: unaccounted ${lane} ${key}`);
        }
      }
      assert.deepEqual(reports.filter(({ operation }) => !['roadmap-sync-dropped', 'roadmap-sync-refused'].includes(operation)), [], label());
    };
    const converge = () => {
      server.acceptAll = true;
      for (let round = 0; round < 12; round += 1) {
        if (session.refusals.size) session.retry();
        if (session.phase !== 'live' || session.inFlight.size || session.progressInFlight.size) {
          if (session.ws?.readyState === 1) session.ws.close();
          session.connect();
          session.ws.open();
        }
        server.deliver();
        timers.advance(400000);
        if (session.ws?.readyState === 0) session.ws.open();
        server.deliver();
        accounted();
        if (!session.pendingStructureCount() && !session.pendingProgressCount()) break;
      }
    };
    const assertConverged = () => {
      for (const lane of ['structure', 'progress']) {
        const local = lane === 'structure' ? session.lattice : session.progress;
        const remote = lane === 'structure' ? server.lattice : server.progress;
        const pending = unconfirmedStamps(writeStamps(local.toFrame()), writeStamps(remote.toFrame()));
        for (const key of Object.keys(pending)) {
          const [section, id] = JSON.parse(key);
          assert.ok(['nodes', 'marks'].includes(section) && id.startsWith('poison-'), `${label()}: silently lost ${lane} ${key}`);
          assert.equal(session.refusals.has(lane), true, label());
        }
        const count = lane === 'structure' ? session.pendingStructureCount() : session.pendingProgressCount();
        assert.equal(count, pendingRecordCount(pending), `${label()}: ${lane} status truth`);
      }
      const clean = (lattice) => ({ ...lattice.toTreeData(),
        nodes: lattice.toTreeData().nodes.filter((node) => !node.id.startsWith('poison-'))
          .map((node) => ({ ...node, prerequisites: [...node.prerequisites].sort() }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      });
      assert.deepEqual(clean(session.lattice), clean(server.lattice), `${label()}: non-poison convergence`);
      if (!session.pendingStructureCount() && !session.pendingProgressCount()) assert.ok(drained > 0, label());
    };
    await reload();
    for (step = 0; step < 80; step += 1) {
      timers.now += 10;
      const nodes = session.lattice.toTreeData().nodes.map(({ id }) => id);
      const node = nodes[Math.floor(random() * nodes.length)] ?? 'root';
      const action = Math.floor(random() * 12);
      actions.add(action);
      if (action === 0) session.dispatch({ kind: 'RenameNode', id: node, label: `Name ${step}` });
      if (action === 1) session.dispatch({ kind: 'DescribeNode', id: node, description: `Description ${step}` });
      if (action === 2) session.dispatch({ kind: 'SetNodeColor', id: node, color: step % 2 ? 'sky' : 'sage' });
      if (action === 3) session.dispatch({ kind: 'CreateNode', id: `created-${serial++}`, label: `New ${step}`, parentId: 'root' });
      if (action === 4 && node !== 'root') session.dispatch({ kind: 'DeleteNode', id: node });
      if (action === 5) {
        session.ws.close();
        const count = 5 + Math.floor(random() * 26);
        const batch = Array.from({ length: count }, () => ({ id: `import-${serial++}`, label: `Import ${step}` }));
        session.dispatch({ kind: 'ImportSubgraph', nodes: batch, edges: batch.map(({ id }) => ({ from: 'root', to: id })) });
        session.connect();
        session.ws.open();
      }
      if (action === 6) session.markProgress(node, step % 2 ? 'complete' : 'none');
      if (action === 7) server.peer(session.ws, node);
      if (action === 8 && session.refusals.size) session.retry();
      if (action === 9) session.ws.close();
      if (action === 10) await reload();
      if (action === 11) {
        timers.advance(400000);
        if (session.ws?.readyState === 0) session.ws.open();
      }
      server.deliver();
      accounted();
    }
    converge();
    assertConverged();
    // Whole-frame admission couples poison to good registers, so poison begins only after the good bank drains.
    if (random() < 0.6) {
      const poison = `poison-${seed}`;
      session.dispatch({ kind: 'CreateNode', id: poison, label: 'Refused', prerequisites: [] });
      session.markProgress(poison, 'complete');
      server.deliver();
      accounted();
      for (step = 80; step < 84; step += 1) {
        if (step % 2) await reload();
        else {
          session.retry();
          session.connect();
          session.ws.open();
          server.deliver();
        }
        accounted();
        assertConverged();
      }
    }
    assert.ok(actions.size > 8, `${label()}: action diversity`);
    assert.ok(server.verdicts.has('accept'), label());
  });
}
