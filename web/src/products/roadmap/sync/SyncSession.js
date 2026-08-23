// The seam SkillTreeView talks to for collaboration and durability: it owns the TreeLattice, the
// client HLC clock, the socket and the IndexedDB store. The lattice is the outbox — the pending
// flush is lattice.deltaSince(ackedServerVector). Coverage rules:
//  - ackedServerVector is in-memory only, never persisted.
//  - it is replaced by the graft frontier on every subscribe, and advanced only by a subgraphAck
//    for one of our own frames; live third-party frames never touch it.
//  - dense seq gates the live plane: a frame joins only when seq === lastSeq + 1, and a gap or a
//    malformed frame forces a resubscribe.
//  - sends fire only in the `live` phase, so the server acquires each actor's stamps as a prefix.

import { socketUrl } from '../../../shell/apiBase.js';
import { HlcClock, TreeLattice, VersionVector, hlcText, parseHlc, compareHlc } from './lattice.js';
import { ProgressLattice } from './progressLattice.js';
import { materialize } from './materialize.js';
import { isOwnershipRefusal, isSessionRefusal, strandsTheBank } from './refusals.js';
import { SyncStore } from './SyncStore.js';
import { LocalTreeRegistry } from '../persistence/LocalTreeRegistry.js';
import { ProgressStore } from '../persistence/ProgressStore.js';
import { GENESIS_STAMP } from '../model/Legend.js';

const DEFAULT_URL = socketUrl();
const MAX_BACKOFF_MS = 8000;
const FLUSH_CHUNK_BYTES = 256 * 1024;
const HEARTBEAT_MS = 20000;
// Dead-socket detection counts consecutive unanswered pings, not wall-clock silence: a
// backgrounded tab's setInterval throttles to ~once/60s. STALE_MS is only for the wake/online path.
const MISSED_PINGS_LIMIT = 3;   // pings unanswered in a row ⇒ half-open ⇒ reconnect (≈60s foreground)
const STALE_MS = 60000;         // on refocus or network return, a minute of silence ⇒ reconnect

function replicaActor() {
  const nonce = crypto.randomUUID?.().slice(0, 8) ?? `${Date.now()}`;
  return `r_${nonce}`;  // one fresh replica identity per tab, so stamps never collide across tabs
}

function frameFrontier(writes) {
  return new TreeLattice().join(writes);  // join returns the frontier of a frame's stamps
}

export class SyncSession {
  constructor({ url = DEFAULT_URL, treeId, title = '', registry = new LocalTreeRegistry() } = {}) {
    this.url = url;
    this.treeId = treeId;
    this.actor = replicaActor();
    this.clock = new HlcClock(this.actor);
    this.lattice = new TreeLattice(treeId, title);  // the doc title is the stampless baseline; any stamped rename dominates
    // This account's own marks: same clock and same blob as the structure, never the same frame.
    this.progress = new ProgressLattice();
    this.store = new SyncStore();
    this.registry = registry;                       // the device-tree index persistNow keeps fresh; null for read-only views
    this.ackedServerVector = new VersionVector();  // in-memory; what the server is known to hold
    this.ackedProgressVector = new VersionVector(); // …and the same, for the private lane
    this.inFlight = new Map();                      // frameId -> VersionVector of that sent frame
    this.progressInFlight = new Map();              // frameId -> VersionVector of that sent progress frame
    this.ws = null;
    this.phase = 'offline';                         // offline | syncing | live
    this.ready = false;
    this.lastSeq = 0;
    this.sent = new Set();                          // frameIds we authored — echoes already applied
    this.durabilityAtRisk = false;
    this.backoffMs = 500;
    this.reconnectTimer = null;
    this.saveTimer = null;
    this.undoStack = [];
    this.redoStack = [];
    this.treeHandler = null;
    this.presenceHandler = null;
    this.peerHandler = null;
    this.progressHandler = null;
    this.drainedHandler = null;
    this.presence = null;
    this.presenceTimer = null;
    this.pagehide = null;
    this.heartbeatTimer = null;
    this.lastRecvAt = 0;        // Date.now() of the last inbound frame — the wake/online staleness clock
    this.pingsSinceRecv = 0;    // consecutive pings with no inbound frame since
    this.onVisible = null;  // refocus reconnect
    this.onOnline = null;   // network-return reconnect
    this.closed = false;
  }

  onTreeChanged(handler) { this.treeHandler = handler; return this; }
  onPresence(handler) { this.presenceHandler = handler; return this; }
  onPeer(handler) { this.peerHandler = handler; return this; }
  onProgress(handler) { this.progressHandler = handler; return this; }
  onDrained(handler) { this.drainedHandler = handler; return this; }

  // Seed a local-only lattice from projected TreeData: every field takes a genesis stamp, so any
  // later edit dominates it. No socket, no IndexedDB.
  seed(treeData) {
    const genesis = GENESIS_STAMP;
    const nodes = treeData.nodes.map((n) => ({
      id: n.id, createdAt: genesis,
      label: n.label ?? '', labelAt: genesis, icon: n.icon ?? '', iconAt: genesis,
      color: n.color ?? 'terracotta', colorAt: genesis,
      order: n.order ?? '', orderAt: genesis,
      ...(n.position ? { position: n.position, positionAt: genesis } : {}),
      ...(n.status ? { status: n.status, statusAt: genesis } : {}),
      ...(n.description ? { description: n.description, descriptionAt: genesis } : {}),
      ...(n.links?.length ? { links: n.links, linksAt: genesis } : {}),
    }));
    const edges = [];
    for (const n of treeData.nodes) for (const p of n.prerequisites ?? []) edges.push({ from: p, to: n.id, addedAt: genesis });
    const kinds = (treeData.kinds ?? []).map((k, i) => ({
      id: k.id, createdAt: genesis, hue: k.hue, hueAt: genesis,
      label: k.label ?? '', labelAt: genesis, description: k.description ?? '', descriptionAt: genesis,
      rank: i, rankAt: genesis,
    }));
    this.lattice = new TreeLattice(treeData.id, treeData.title);
    this.lattice.join({ nodes, edges, kinds });
    this.lattice.seedClock(this.clock);
    this.ready = true;
    this.emitTree();
  }

  async start() {
    let saved = null;
    try { saved = await this.store.load(this.treeId); } catch { this.durabilityAtRisk = true; }
    if (saved?.frame) {
      try { this.lattice.join(saved.frame); this.lastSeq = saved.lastSeq ?? 0; }
      catch { this.lattice = new TreeLattice(this.treeId); this.lastSeq = 0; }  // corrupt blob → start fresh
      this.lattice.seedClock(this.clock);
      this.ready = true;
      this.emitTree();
    }
    // A corrupt private lane starts empty rather than taking the structure down with it.
    if (saved?.progress) {
      try { this.progress.join(saved.progress); }
      catch { this.progress = new ProgressLattice(); }
    }
    // localStorage residue folds in uncovered, so the first graft flushes it.
    if (this.registry) new ProgressStore().drainInto(this.treeId, this.progress);
    if (this.progress.marks.size) {
      this.progress.seedClock(this.clock);
      this.progressHandler?.(this.progress.overlay());
    }
    this.store.requestPersistent().then((granted) => { if (!granted) this.durabilityAtRisk = true; });
    if (typeof window !== 'undefined') {
      this.pagehide = () => this.persistNow();
      window.addEventListener('pagehide', this.pagehide);
      // A sleep/wake or network flap can leave the socket half-open: OPEN, no bytes, no `close`.
      this.onVisible = () => { if (document.visibilityState === 'visible') this.reconnectIfStale(); };
      this.onOnline = () => this.reconnectIfStale();
      document.addEventListener('visibilitychange', this.onVisible);
      window.addEventListener('online', this.onOnline);
    }
    this.connect();
    return this;
  }

  connect() {
    clearTimeout(this.reconnectTimer);
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('open', () => {
      this.phase = 'syncing';
      // Send our coverage so the server replies with only the gap.
      this.ws.send(JSON.stringify({ t: 'subscribe', treeId: this.treeId, lastSeq: this.lastSeq, vector: this.ackedServerVector.toJSON() }));
      this.startHeartbeat();
    });
    this.ws.addEventListener('message', (event) => {
      this.lastRecvAt = Date.now();  // any inbound frame proves the pipe is alive — bump before parse
      this.pingsSinceRecv = 0;
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      this.receive(frame);
    });
    this.ws.addEventListener('close', () => {
      this.stopHeartbeat();
      this.phase = 'offline';
      this.inFlight.clear();  // unacked frontiers die with the connection — never persisted
      if (!this.closed) this.scheduleReconnect();
    });
    this.ws.addEventListener('error', () => { try { this.ws?.close(); } catch { /* close handler reconnects */ } });
    return this;
  }

  scheduleReconnect() {
    const wait = this.backoffMs * (0.5 + Math.random() * 0.5);  // full jitter
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  forceReconnect() {
    try { this.ws?.close(); } catch { /* ignore */ }  // the close handler schedules the reconnect + graft resync
  }

  // A half-open socket leaves readyState OPEN with no bytes flowing and fires no `close`, so
  // unanswered pings force a reconnect; the graft that follows is the only resync.
  startHeartbeat() {
    this.stopHeartbeat();
    this.lastRecvAt = Date.now();
    this.pingsSinceRecv = 0;  // the subscribe reply answers as an inbound frame; start the count clean
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;  // the close handler owns reconnection while not open
      this.ws.send(JSON.stringify({ t: 'ping', treeId: this.treeId }));
      this.pingsSinceRecv += 1;
      if (this.pingsSinceRecv >= MISSED_PINGS_LIMIT) this.forceReconnect();  // unanswered ⇒ half-open
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  reconnectIfStale() {
    if (this.ws?.readyState !== WebSocket.OPEN || Date.now() - this.lastRecvAt > STALE_MS) this.forceReconnect();
  }

  receive(frame) {
    if (frame.t === 'pong' || frame.t === 'ping') return;  // liveness already bumped by the listener
    // Only the subscribe reply ('delta') may re-baseline coverage.
    if (frame.t === 'subgraph') return frame.intent === 'delta' ? this.receiveState(frame) : this.receiveLive(frame);
    if (frame.t === 'subgraphAck') return this.receiveAck(frame);
    if (frame.t === 'skew') return this.receiveSkew(frame);
    if (frame.t === 'presence') return void this.presenceHandler?.(frame);
    if (frame.t === 'peer') return void this.peerHandler?.(frame);
    // The private lane's two frames: a graft re-baselines its coverage, an echo only folds in.
    if (frame.t === 'progress') return frame.intent === 'graft' ? this.receiveProgressGraft(frame) : this.receiveProgress(frame);
    if (frame.t === 'progressAck') return this.receiveProgressAck(frame);
    if (frame.t === 'reject') return this.receiveReject(frame);
  }

  // The subscribe response: re-baselines coverage and seq, then flushes whatever the server is
  // missing. A frame with no `coverage` is a full state, so its join frontier is the frontier.
  receiveState(frame) {
    let frontier;
    try { frontier = this.lattice.join(frame); } catch { this.forceReconnect(); return; }
    for (const [actor, m] of frontier.marks) this.clock.observe({ ms: m.ms, counter: m.counter, actor });
    if (typeof frame.seq === 'number') this.lastSeq = frame.seq;
    this.ackedServerVector = frame.coverage ? VersionVector.fromJSON(frame.coverage) : frontier;
    this.persistNow();
    this.ready = true;
    this.emitTree();
    this.flush();
    this.phase = 'live';
    this.backoffMs = 500;
    this.noteDrained();    // an empty flush means the server already covers everything
  }

  // A live broadcast: dense-seq gated, and never touches coverage.
  receiveLive(frame) {
    if (typeof frame.seq !== 'number') return;
    if (frame.seq <= this.lastSeq) return;                                 // duplicate / already seen
    if (frame.seq > this.lastSeq + 1) { this.forceReconnect(); return; }   // gap → heal via a fresh graft
    let frontier;
    try { frontier = this.lattice.join(frame); } catch { this.forceReconnect(); return; }
    for (const [actor, m] of frontier.marks) this.clock.observe({ ms: m.ms, counter: m.counter, actor });
    this.lastSeq = frame.seq;  // advance only after a successful join
    const mine = frame.frameId && this.sent.has(frame.frameId);
    if (mine) this.sent.delete(frame.frameId);
    this.scheduleSave();       // received content is already server-durable → coalesced save is safe
    if (!mine) this.emitTree();
  }

  receiveAck(frame) {
    const vector = this.inFlight.get(frame.frameId);
    if (vector) { this.ackedServerVector.join(vector); this.inFlight.delete(frame.frameId); this.noteDrained(); }
  }

  // Fires whenever the wire goes idle with full coverage: live, nothing pending, nothing in flight.
  noteDrained() {
    if (this.phase !== 'live' || this.inFlight.size > 0 || this.progressInFlight.size > 0) return;
    if (this.pendingEditCount() > 0) return;
    if (this.progress.deltaSince(this.ackedProgressVector).marks.length > 0) return;
    this.drainedHandler?.();
  }

  // The private lane's graft: the server's whole overlay for this account. It replaces coverage,
  // so a mark the server no longer holds re-flushes; an empty graft still has to arrive.
  receiveProgressGraft(frame) {
    let frontier;
    try { frontier = this.progress.join(frame); } catch { this.forceReconnect(); return; }
    for (const [actor, m] of frontier.marks) this.clock.observe({ ms: m.ms, counter: m.counter, actor });
    this.ackedProgressVector = frontier;
    this.persistNow();
    this.progressHandler?.(this.progress.overlay());
    this.flushProgress();
  }

  // A live echo, folded in and never a coverage input.
  receiveProgress(frame) {
    let frontier;
    try { frontier = this.progress.join(frame); } catch { this.forceReconnect(); return; }
    for (const [actor, m] of frontier.marks) this.clock.observe({ ms: m.ms, counter: m.counter, actor });
    this.persistNow();
    this.progressHandler?.(this.progress.overlay());
  }

  receiveProgressAck(frame) {
    const vector = this.progressInFlight.get(frame.frameId);
    if (!vector) return;
    this.ackedProgressVector.join(vector);
    this.progressInFlight.delete(frame.frameId);
    this.noteDrained();
  }

  // Stamped, folded and persisted before anything is sent, so a mark that never reaches the socket
  // is merely uncovered and the next flush carries it.
  markProgress(nodeId, status) {
    const now = Date.now();
    if (!this.progress.mark(nodeId, status, this.clock.tick(now), now)) return this.progress.overlay();
    this.persistNow();
    this.flushProgress();
    return this.progress.overlay();
  }

  flushProgress() {
    if (this.phase !== 'live' || this.ws?.readyState !== WebSocket.OPEN) return;
    const pending = this.progress.deltaSince(this.ackedProgressVector);
    if (!pending.marks.length) return;
    const frameId = crypto.randomUUID?.() ?? `p-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    this.progressInFlight.set(frameId, new ProgressLattice().join(pending));
    this.ws.send(JSON.stringify({ t: 'progress', treeId: this.treeId, frameId, marks: pending.marks }));
  }

  receiveSkew(frame) {
    this.clock.observe({ ms: frame.serverNow ?? 0, counter: 0, actor: 'srv' });
    this.inFlight.delete(frame.frameId);
    this.durabilityAtRisk = true;  // pending edits are stranded until the clock catches up
    // Real time overtakes any finite skew: re-flush once the local max stamp is no longer ahead.
    const pending = frameFrontier(this.lattice.deltaSince(this.ackedServerVector));
    let maxMs = 0;
    for (const m of pending.marks.values()) maxMs = Math.max(maxMs, m.ms);
    const deficit = Math.max(1000, maxMs - (frame.serverNow ?? 0) + 1000);
    setTimeout(() => { if (this.phase === 'live') this.flush(); }, deficit);
  }

  receiveReject(frame) {
    if (frame.frameId) this.inFlight.delete(frame.frameId);
    // A refused subgraph frame strands the edits banked behind it, whatever its code.
    if (strandsTheBank(frame)) this.durabilityAtRisk = true;
    if (!strandsTheBank(frame) && !isOwnershipRefusal(frame) && !isSessionRefusal(frame)) {
      console.warn('[sync] frame rejected —', frame.code, frame.reason);
      return;
    }
    window.dispatchEvent(new CustomEvent('wm-edit-forbidden', { detail: frame }));
  }

  emitTree() { this.treeHandler?.(this.lattice.toTreeData()); }

  // How much of the bank the server does not hold.
  pendingEditCount() {
    const pending = this.lattice.deltaSince(this.ackedServerVector);
    return pending.nodes.length + pending.edges.length + pending.kinds.length + (pending.title ? 1 : 0);
  }

  // Everything the server does not yet cover — the outbox, derived not queued.
  flush() {
    const pending = this.lattice.deltaSince(this.ackedServerVector);
    if (!pending.nodes.length && !pending.edges.length && !pending.kinds.length && !pending.title) return;
    for (const chunk of chunkDelta(pending)) this.send(chunk, 'flush');
  }

  dispatch(gesture) {
    if (!this.ready) return;
    const writes = materialize(gesture, this.lattice, this.clock);
    if (!writes.nodes.length && !writes.edges.length && !writes.kinds.length) return;
    this.undoStack.push(this.captureInverse(writes));
    this.redoStack = [];
    this.apply(writes);
  }

  // One stamped write to the title register, LWW against concurrent renames and out of the undo
  // journal. Returns false before the durable lattice loads, when the caller must PATCH instead.
  renameTree(title) {
    if (!this.ready) return false;
    const next = title.trim();
    if (!next || next === this.lattice.title) return true;
    const at = this.clock.tick(Date.now());
    this.apply({ nodes: [], edges: [], kinds: [], title: { v: next, at: hlcText(at) } });
    return true;
  }

  undo() { this.replay(this.undoStack, this.redoStack); }
  redo() { this.replay(this.redoStack, this.undoStack); }

  replay(from, to) {
    const inverse = from.pop();
    if (!inverse) return;
    const writes = this.restamp(inverse, this.clock.tick(Date.now()));
    to.push(this.captureInverse(writes));  // the counter-inverse, captured before applying
    this.apply(writes);
  }

  apply(writes) {
    this.lattice.join(writes);
    this.emitTree();
    this.persistNow();                     // durable before the wire; the outbox catches offline edits
    if (this.phase === 'live') this.send(writes);
  }

  send(writes, intent = 'live') {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const frameId = crypto.randomUUID?.() ?? `f-${Date.now()}-${Math.random()}`;
    this.sent.add(frameId);
    this.inFlight.set(frameId, frameFrontier(writes));  // remembered so its ack can advance coverage
    const frame = {
      t: 'subgraph', v: 1, treeId: this.treeId, frameId, actor: this.actor, intent,
      nodes: writes.nodes ?? [], edges: writes.edges ?? [], kinds: writes.kinds ?? [],
    };
    if (writes.title) frame.title = writes.title;
    this.ws.send(JSON.stringify(frame));
  }

  // Persists both lanes + lastSeq atomically; the snapshot is taken synchronously, before any
  // await. A closed session never writes. Returns the save's settle.
  persistNow() {
    if (this.closed) return Promise.resolve();
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const value = { frame: this.lattice.toFrame(), progress: this.progress.toFrame(), lastSeq: this.lastSeq };
    this.registry?.touch(this.treeId, this.lattice.title);
    return this.store.save(this.treeId, value).catch(() => { this.durabilityAtRisk = true; });
  }

  // Coalesced save for the receive path: received content is already server-durable.
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.persistNow(); }, 250);
  }

  captureInverse(writes) {
    const nodes = (writes.nodes ?? []).map((n) => {
      const record = this.lattice.nodes.get(n.id);
      const inv = { id: n.id };
      if (n.createdAt) inv.deleteLife = true;   // undo a create → tombstone
      if (n.deletedAt) inv.addLife = true;      // undo a delete → re-add; fields survive in the lattice
      if ('labelAt' in n) inv.label = record ? record.label.v : '';
      if ('iconAt' in n) inv.icon = record ? record.icon.v : '';
      if ('colorAt' in n) inv.color = record ? record.color.v : 'terracotta';
      if ('orderAt' in n) inv.order = record ? record.order.v : '';
      if ('positionAt' in n) inv.position = record ? record.position.v : null;
      if ('statusAt' in n) inv.status = record ? record.status.v : null;
      if ('descriptionAt' in n) inv.description = record ? record.description.v : '';
      if ('linksAt' in n) inv.links = record ? record.links.v : [];
      return inv;
    });
    const edges = (writes.edges ?? []).map((e) => (
      e.addedAt ? { from: e.from, to: e.to, remove: true } : { from: e.from, to: e.to, add: true }));
    const kinds = (writes.kinds ?? []).map((k) => {
      const record = this.lattice.kinds.get(k.id);
      const inv = { id: k.id };
      if (k.createdAt) inv.deleteLife = true;
      if (k.deletedAt) inv.addLife = true;
      if ('hueAt' in k) inv.hue = record ? record.hue.v : 'terracotta';
      if ('labelAt' in k) inv.label = record ? record.label.v : '';
      if ('descriptionAt' in k) inv.description = record ? record.description.v : '';
      if ('rankAt' in k) inv.rank = record ? record.rank.v : 0;
      return inv;
    });
    return { nodes, edges, kinds };
  }

  restamp(inverse, at) {
    const s = hlcText(at);
    const nodes = (inverse.nodes ?? []).map((n) => {
      const e = { id: n.id };
      if (n.deleteLife) e.deletedAt = s;
      if (n.addLife) e.createdAt = s;
      if ('label' in n) { e.label = n.label; e.labelAt = s; }
      if ('icon' in n) { e.icon = n.icon; e.iconAt = s; }
      if ('color' in n) { e.color = n.color; e.colorAt = s; }
      if ('order' in n) { e.order = n.order; e.orderAt = s; }
      if ('position' in n) { e.position = n.position; e.positionAt = s; }
      if ('status' in n) { e.status = n.status; e.statusAt = s; }
      if ('description' in n) { e.description = n.description; e.descriptionAt = s; }
      if ('links' in n) { e.links = n.links; e.linksAt = s; }
      return e;
    });
    const edges = (inverse.edges ?? []).map((x) => (
      x.add ? { from: x.from, to: x.to, addedAt: s } : { from: x.from, to: x.to, removedAt: s }));
    const kinds = (inverse.kinds ?? []).map((k) => {
      const e = { id: k.id };
      if (k.deleteLife) e.deletedAt = s;
      if (k.addLife) e.createdAt = s;
      if ('hue' in k) { e.hue = k.hue; e.hueAt = s; }
      if ('label' in k) { e.label = k.label; e.labelAt = s; }
      if ('description' in k) { e.description = k.description; e.descriptionAt = s; }
      if ('rank' in k) { e.rank = k.rank; e.rankAt = s; }
      return e;
    });
    return { nodes, edges, kinds };
  }

  sendPresence(cursor, selection) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.presence = { cursor, selection };
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      if (!this.presence || this.ws?.readyState !== WebSocket.OPEN) return;
      const { cursor, selection } = this.presence;
      this.presence = null;
      this.ws.send(JSON.stringify({ t: 'presence', treeId: this.treeId, cursor, selection }));
    }, 40);
  }

  maskedWork() { return this.lattice.maskedWork(); }

  // Present and tombstoned ids, so a colliding slug never resurrects a deleted node.
  knownNodeIds() { return this.lattice.knownNodeIds(); }

  clearDurable() { this.store.clear(this.treeId).catch(() => {}); }

  close() {
    this.closed = true;
    if (typeof window !== 'undefined') {
      if (this.pagehide) window.removeEventListener('pagehide', this.pagehide);
      if (this.onVisible) document.removeEventListener('visibilitychange', this.onVisible);
      if (this.onOnline) window.removeEventListener('online', this.onOnline);
    }
    this.pagehide = this.onVisible = this.onOnline = null;
    this.stopHeartbeat();
    clearTimeout(this.presenceTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.saveTimer);
    this.presenceTimer = this.reconnectTimer = this.saveTimer = null;
    this.ws?.close();
    this.ws = null;
  }
}

// Splits an oversized flush by entry count; each chunk is an independently valid subgraph and the
// title rides the first.
function* chunkDelta(delta) {
  if (JSON.stringify(delta).length <= FLUSH_CHUNK_BYTES) { yield delta; return; }
  const all = [
    ...delta.nodes.map((n) => ['nodes', n]),
    ...delta.edges.map((e) => ['edges', e]),
    ...delta.kinds.map((k) => ['kinds', k]),
  ];
  const parts = Math.ceil(JSON.stringify(delta).length / FLUSH_CHUNK_BYTES);
  const perChunk = Math.max(1, Math.ceil(all.length / parts));
  for (let i = 0; i < all.length; i += perChunk) {
    const chunk = { nodes: [], edges: [], kinds: [] };
    for (const [section, entry] of all.slice(i, i + perChunk)) chunk[section].push(entry);
    if (i === 0 && delta.title) chunk.title = delta.title;
    yield chunk;
  }
}
