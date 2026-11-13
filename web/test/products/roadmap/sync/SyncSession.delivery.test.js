import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncSession } from '../../../../src/products/roadmap/sync/SyncSession.js';
import { TreeLattice, VersionVector, parseHlc } from '../../../../src/products/roadmap/sync/lattice.js';
import { ProgressLattice } from '../../../../src/products/roadmap/sync/progressLattice.js';
import { frameWrites, pendingGestures, pendingRecordCount, unconfirmedStamps, writeStamps } from '../../../../src/products/roadmap/sync/pendingWrites.js';

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
  setInterval(callback, interval) {
    const id = this.setTimeout(callback, interval);
    this.pending.get(id).interval = interval;
    return id;
  }
  clearInterval(id) { this.pending.delete(id); }
  advance(milliseconds, afterTimer = () => {}) {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.pending].filter(([, timer]) => timer.due <= target)
        .sort(([, left], [, right]) => left.due - right.due)[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = Math.max(this.now, timer.due);
      if (timer.interval) timer.due += timer.interval;
      else this.pending.delete(id);
      timer.callback();
      afterTimer();
    }
    this.now = target;
  }
}

// Collab's subscribe masks the payload by actor, but coverage describes the entire room.
function serverDelta(frame, vector) {
  const coverage = VersionVector.fromJSON(vector);
  return frameWrites(frame, (key, stamp) => !coverage.covers(parseHlc(stamp)));
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
    this.nextVerdict = null;
  }
  deliver() {
    let delivered = 0;
    while (this.queue.length) {
      assert.ok(++delivered < 10000, 'reply delivery must terminate');
      const { socket, frame } = this.queue.shift();
      if (socket.readyState !== 1) continue;
      if (frame.t === 'subscribe') {
        const state = this.lattice.toFrame();
        socket.message({ t: 'subgraph', intent: 'delta', seq: this.head,
          ...serverDelta(state, frame.vector), coverage: this.lattice.frontier().toJSON() }, state);
        socket.message({ t: 'progress', intent: 'graft', ...this.progress.toFrame() });
        continue;
      }
      if (frame.t === 'ping') {
        socket.message({ t: 'pong' });
        continue;
      }
      assert.ok(['subgraph', 'progress'].includes(frame.t));
      const poison = (frame.nodes ?? frame.marks).some((row) => (row.id ?? row.node).startsWith('poison-'));
      const draw = this.acceptAll ? 0 : this.random() * 0.95;
      const verdict = poison ? 'poison' : this.nextVerdict ?? (draw < 0.55 ? 'accept' : draw < 0.65 ? 'reject'
        : draw < 0.75 ? 'drop' : draw < 0.8 ? 'skew' : draw < 0.85 ? 'echo-drop' : draw < 0.9 ? 'echo-close' : 'close');
      this.nextVerdict = null;
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
        if (verdict === 'echo-drop') continue;
        if (verdict === 'echo-close') {
          socket.close();
          continue;
        }
        socket.message({ t: 'subgraphAck', frameId: frame.frameId, seq: this.seen.get(frame.frameId) });
        continue;
      }
      // Progress upserts compare physical time and counter, without an actor tiebreak.
      const recorded = [];
      for (const mark of frame.marks) {
        const held = this.progress.marks.get(mark.node)?.at;
        const at = parseHlc(mark.at);
        if (held && (held.ms > at.ms || (held.ms === at.ms && held.counter >= at.counter))) continue;
        const receipt = { ...mark, markedAt: this.timers.now };
        this.progress.join({ marks: [receipt] });
        recorded.push(receipt);
      }
      if (recorded.length) socket.message({ t: 'progress', treeId: 'tree', marks: recorded });
      if (verdict === 'echo-drop') continue;
      if (verdict === 'echo-close') {
        socket.close();
        continue;
      }
      socket.message({ t: 'progressAck', frameId: frame.frameId });
    }
  }
  peer(socket, node, field = 'description') {
    const stamp = `${++this.timers.now}:0:r_peer`;
    const frame = { t: 'subgraph', intent: 'live', frameId: `peer-${this.head + 1}`, actor: 'r_peer',
      nodes: [{ id: node, [field]: `Peer ${this.head}`, [`${field}At`]: stamp }], edges: [], kinds: [] };
    this.lattice.join(frame);
    this.head += 1;
    if (socket?.readyState === 1) socket.message({ ...frame, seq: this.head });
  }
}

async function deliveryHarness(t, seed) {
  const random = mulberry32(seed);
  const timers = new DeliveryTimers();
  const server = new DeliveryServer(random, timers);
  const reports = [];
  let record = null;
  let session;
  let identity = 0;
  let drained = 0;
  let step = -1;
  const label = () => `seed ${seed}, step ${step}`;
  const copyRecord = (value) => JSON.parse(JSON.stringify(value));
  const store = {
    load: async () => copyRecord(record),
    save: async (treeId, value) => { record = copyRecord(value); },
    requestPersistent: async () => true,
    replaceLane: async (treeId, lane, epoch, discarded) => {
      assert.equal(record.epochs[lane], epoch, label());
      const field = lane === 'structure' ? 'frame' : 'progress';
      const remaining = frameWrites(record[field], (key, stamp) => discarded[key] !== stamp);
      const replacement = lane === 'structure' ? new TreeLattice('tree', 'Tree') : new ProgressLattice();
      replacement.join(record.confirmed[lane]);
      replacement.join(remaining);
      record[field] = replacement.toFrame();
      record.epochs[lane] += 1;
      record.gestures[lane] = pendingGestures(record[field], record.confirmed[lane]);
      if (lane === 'structure') record.lastSeq = 0;
      return { status: 'replaced', value: copyRecord(record) };
    },
  };
  class DeliverySocket extends EventTarget {
    static OPEN = 1;
    constructor() {
      super();
      this.readyState = 0;
      this.frames = new Map();
      this.frameStamps = new Map();
      this.confirmedOnGraft = {};
    }
    send(text) {
      const frame = JSON.parse(text);
      if (frame.frameId) {
        this.frames.set(frame.frameId, frame);
        this.frameStamps.set(frame.frameId, writeStamps(frame));
      }
      if (frame.t === 'subgraph' && frame.intent === 'flush') {
        for (const [key, stamp] of Object.entries(this.frameStamps.get(frame.frameId))) {
          assert.notEqual(this.confirmedOnGraft[key], stamp, `${label()}: resends a mutually confirmed register ${key}`);
        }
      }
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
    message(frame, serverState) {
      if (frame.t === 'subgraph' && frame.intent === 'delta') {
        const confirmed = writeStamps(session.confirmedStructure.toFrame());
        const remote = writeStamps(serverState);
        this.confirmedOnGraft = Object.fromEntries(Object.entries(confirmed).filter(([key, stamp]) => remote[key] === stamp));
      }
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
  const advance = (milliseconds) => timers.advance(milliseconds, () => {
    if (session.ws?.readyState === 0) session.ws.open();
    server.deliver();
  });
  const accounted = () => {
    for (const lane of ['structure', 'progress']) {
      if (session.refusals.has(lane) || session.resendTimers?.[lane] != null
        || session.skewTimers?.[lane] != null || session.phase !== 'live') continue;
      const local = lane === 'structure' ? session.lattice : session.progress;
      const confirmed = lane === 'structure' ? session.confirmedStructure : session.confirmedProgress;
      const inFlight = lane === 'structure' ? session.inFlight : session.progressInFlight;
      const carried = [...inFlight.keys()].map((id) => session.ws.frameStamps.get(id));
      const pending = unconfirmedStamps(writeStamps(local.toFrame()), writeStamps(confirmed.toFrame()));
      for (const [key, stamp] of Object.entries(pending)) {
        assert.ok(carried.some((frame) => frame[key] === stamp),
        `${label()}: unaccounted ${lane} ${key}`);
      }
    }
    assert.deepEqual(reports.filter(({ operation }) => !['roadmap-sync-dropped', 'roadmap-sync-refused', 'roadmap-sync-unlandable'].includes(operation)), [], label());
  };
  const converge = () => {
    server.acceptAll = true;
    for (let round = 0; round < 6; round += 1) {
      if (session.refusals.size) session.retry();
      if (session.phase !== 'live') {
        session.connect();
        session.ws.open();
      }
      server.deliver();
      advance(400000);
      accounted();
      const structureSettled = !session.pendingStructureCount() || session.refusals.has('structure');
      const progressSettled = !session.pendingProgressCount() || session.refusals.has('progress');
      if (structureSettled && progressSettled && !session.inFlight.size && !session.progressInFlight.size) break;
    }
  };
  const assertDelivery = (strict = false) => {
    for (const lane of ['structure', 'progress']) {
      const local = lane === 'structure' ? session.lattice : session.progress;
      const remote = lane === 'structure' ? server.lattice : server.progress;
      const localStamps = writeStamps(local.toFrame());
      const pending = unconfirmedStamps(localStamps, writeStamps(remote.toFrame()));
      const confirmed = lane === 'structure' ? session.confirmedStructure : session.confirmedProgress;
      const unconfirmed = unconfirmedStamps(localStamps, writeStamps(confirmed.toFrame()));
      for (const [key, stamp] of Object.entries(pending)) {
        assert.ok(!strict && session.refusals.has(lane) && unconfirmed[key] === stamp,
          `${label()}: silently lost ${lane} ${key}`);
      }
      const count = lane === 'structure' ? session.pendingStructureCount() : session.pendingProgressCount();
      assert.equal(count, pendingRecordCount(unconfirmed), `${label()}: ${lane} status truth`);
      if (strict) {
        assert.deepEqual(pending, {}, label());
        assert.equal(count, 0, `${label()}: ${lane} drains`);
      }
    }
    if (!strict) return;
    const canonical = (lattice) => ({ ...lattice.toTreeData(),
      nodes: lattice.toTreeData().nodes.map((node) => ({ ...node, prerequisites: [...node.prerequisites].sort() }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
    assert.deepEqual(canonical(session.lattice), canonical(server.lattice), `${label()}: full structure convergence`);
    assert.deepEqual(session.progress.toFrame(), server.progress.toFrame(), `${label()}: full progress convergence`);
    assert.deepEqual([session.inFlight.size, session.progressInFlight.size, session.refusals.size], [0, 0, 0], label());
    assert.ok(drained > 0, label());
  };
  await reload();
  return { random, timers, server, reload, advance, accounted, converge, assertDelivery, label,
    get session() { return session; }, set step(value) { step = value; } };
}

// Permanent seeds exercise failures observed against the original actor-frontier delivery rule.
const PERMANENT_SEEDS = [7, 19];
const seedCount = Number(process.env.DELIVERY_SEEDS ?? 64);
assert.ok(Number.isSafeInteger(seedCount) && seedCount > 0, 'DELIVERY_SEEDS must be a positive integer');

for (const seed of [...new Set([...PERMANENT_SEEDS, ...Array.from({ length: seedCount }, (_, index) => index + 1)])]) {
  test(`delivery preserves every register through replies and reloads, seed ${seed}`, async (t) => {
    const harness = await deliveryHarness(t, seed);
    const { random, timers, server, label } = harness;
    let serial = 0;
    const actions = new Set();
    for (let step = 0; step < 80; step += 1) {
      harness.step = step;
      timers.now += 10;
      const session = harness.session;
      const nodes = session.lattice.toTreeData().nodes.map(({ id }) => id);
      const node = nodes[Math.floor(random() * nodes.length)] ?? 'root';
      const action = Math.floor(random() * 13);
      actions.add(action);
      if (action === 0) session.dispatch({ kind: 'RenameNode', id: node, label: `Name ${step}` });
      if (action === 1) session.dispatch({ kind: 'DescribeNode', id: node, description: `Description ${step}` });
      if (action === 2) session.dispatch({ kind: 'SetNodeColor', id: node, color: step % 2 ? 'sky' : 'sage' });
      if (action === 3) {
        const id = `${random() < 0.25 ? 'poison' : 'created'}-${serial++}`;
        session.dispatch({ kind: 'CreateNode', id, label: `New ${step}`, parentId: 'root' });
      }
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
      if (action === 10) await harness.reload();
      if (action === 11) harness.advance(400000);
      if (action === 12) {
        session.ws.close();
        server.peer(session.ws, node, 'label');
      }
      server.deliver();
      harness.accounted();
    }
    harness.converge();
    harness.assertDelivery();
    for (let lane = 0; lane < 2 && harness.session.refusals.size; lane += 1) {
      assert.equal(await harness.session.discard(), true, label());
      harness.advance(1000);
      harness.converge();
    }
    harness.assertDelivery(true);
    assert.ok(actions.size > 8, `${label()}: action diversity`);
    assert.ok(server.verdicts.has('accept'), label());
  });
}

test('disconnected peer supersedes the last old actor register without resending a confirmed room', async (t) => {
  const harness = await deliveryHarness(t, 902);
  const { server, session } = harness;
  server.acceptAll = true;
  const nodes = Array.from({ length: 299 }, (_, index) => ({
    id: `node-${index}`, createdAt: '5:0:server', label: `Node ${index}`, labelAt: '5:0:server',
  }));
  server.lattice.join({ nodes: [...nodes, { id: 'old', createdAt: '5:0:server', label: 'Old', labelAt: '7:0:r_old' }], edges: [], kinds: [] });
  server.head += 1;
  session.ws.close();
  session.connect();
  session.ws.open();
  server.deliver();
  assert.equal(session.lattice.toTreeData().nodes.length, 301);
  assert.equal(session.pendingStructureCount(), 0);
  session.ws.close();
  server.peer(session.ws, 'old', 'label');
  assert.equal(server.lattice.frontier().toJSON().r_old, undefined);
  session.connect();
  session.ws.open();
  server.deliver();
  assert.deepEqual([...session.ws.frames.values()].filter((frame) => frame.t === 'subgraph'), []);
  assert.equal(session.pendingStructureCount(), 0);
  harness.assertDelivery(true);
});

for (const lane of ['structure', 'progress']) {
  test(`server restore reopens confirmed multi-record ${lane} writes after reload`, async (t) => {
    const harness = await deliveryHarness(t, 900);
    const { server } = harness;
    const backup = server.lattice.toFrame();
    server.acceptAll = true;
    if (lane === 'structure') {
      harness.session.dispatch({ kind: 'ImportSubgraph',
        nodes: [{ id: 'child', label: 'Child', description: 'Recovered description' }, { id: 'removed', label: 'Removed' }],
        edges: [{ from: 'root', to: 'child' }, { from: 'root', to: 'removed' }],
        kinds: [{ id: 'custom', hue: 'sky', label: 'Recovered kind' }],
      });
      harness.session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Recovered' });
      harness.session.dispatch({ kind: 'DeleteNode', id: 'removed' });
      harness.session.renameTree('Recovered title');
    } else {
      harness.session.markProgress(['root', 'child'], 'complete');
      harness.session.markProgress('root', 'none');
      harness.session.markProgress('other', 'complete');
    }
    server.deliver();
    harness.assertDelivery(true);
    const committed = lane === 'structure' ? server.lattice.toFrame() : server.progress.toFrame();
    await harness.session.persistNow();
    server.lattice = new TreeLattice('tree', 'Tree');
    server.lattice.join(backup);
    server.progress = new ProgressLattice();
    server.head = 1;
    server.seen.clear();
    await harness.reload();
    harness.converge();
    harness.assertDelivery(true);
    assert.deepEqual(lane === 'structure' ? server.lattice.toFrame() : server.progress.toFrame(), committed);
  });

  test(`model ${lane} echo without ack stays open and settles through a heartbeat pong`, async (t) => {
    const harness = await deliveryHarness(t, 901);
    const { server, session } = harness;
    server.acceptAll = true;
    server.nextVerdict = 'echo-drop';
    if (lane === 'structure') session.dispatch({ kind: 'RenameNode', id: 'root', label: 'Echoed' });
    else session.markProgress('root', 'complete');
    server.deliver();
    const pending = lane === 'structure' ? session.pendingStructureCount() : session.pendingProgressCount();
    assert.equal(pending, lane === 'structure' ? 1 : 0);
    assert.equal(session.ws.readyState, 1);
    const socket = session.ws;
    harness.advance(21000);
    assert.equal(session.ws, socket);
    harness.assertDelivery(true);
  });
}
