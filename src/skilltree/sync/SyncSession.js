// The one seam SkillTreeView talks to for collaboration AND durability. It owns the
// TreeLattice (truth), the client HLC clock, the socket, and the IndexedDB store. A local
// edit is materialized to stamped writes, joined, persisted, and — only when live — sent as
// one subgraph frame; a remote frame is joined the same way. TreeData is only what the view
// renders (always lattice.toTreeData()). "The lattice is the outbox": there is no queue — the
// pending flush is derived as lattice.deltaSince(ackedServerVector).
//
// Coverage discipline (the hard-won part; see GRAPH_SYNC_DESIGN.md §6 and the Step-4 red-team):
//  - ackedServerVector is in-memory only, never persisted; the persisted value is {frame,lastSeq}.
//  - it is REPLACED by the graft frontier on every subscribe (so anything the server no longer
//    holds becomes uncovered and re-flushes — this heals a server restart), and advanced only by
//    a subgraphAck for one of our own frames. Live third-party frames never touch it.
//  - dense seq is the live-plane gap detector: a live frame joins only when seq === lastSeq+1;
//    a gap or a malformed frame forces a resubscribe (the graft is the resync).
//  - sends fire only in the `live` phase, entered after the graft is joined+persisted and the
//    flush is handed off — so the server acquires each actor's stamps as a prefix.

import { socketUrl } from '../apiBase.js';
import { HlcClock, TreeLattice, VersionVector, hlcText, parseHlc, compareHlc } from './lattice.js';
import { materialize } from './materialize.js';
import { SyncStore } from './SyncStore.js';
import { LocalTreeRegistry } from '../persistence/LocalTreeRegistry.js';
import { GENESIS_STAMP } from '../model/Legend.js';

const DEFAULT_URL = socketUrl();
const MAX_BACKOFF_MS = 8000;
const FLUSH_CHUNK_BYTES = 256 * 1024;

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
    this.store = new SyncStore();
    this.registry = registry;                       // the device-tree index persistNow keeps fresh; null for read-only views
    this.ackedServerVector = new VersionVector();  // in-memory; what the server is known to hold
    this.inFlight = new Map();                      // frameId -> VersionVector of that sent frame
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
    this.liveHandler = null;
    this.drainedHandler = null;
    this.presence = null;
    this.presenceTimer = null;
    this.pagehide = null;
    this.closed = false;
  }

  onTreeChanged(handler) { this.treeHandler = handler; return this; }
  onPresence(handler) { this.presenceHandler = handler; return this; }
  onPeer(handler) { this.peerHandler = handler; return this; }
  onProgress(handler) { this.progressHandler = handler; return this; }
  onLive(handler) { this.liveHandler = handler; return this; }
  onDrained(handler) { this.drainedHandler = handler; return this; }

  // Seed a local-only lattice from projected TreeData (the perf tree): every field takes a
  // genesis stamp, so any later edit dominates it. No socket, no IndexedDB.
  seed(treeData) {
    const genesis = GENESIS_STAMP;
    const nodes = treeData.nodes.map((n) => ({
      id: n.id, createdAt: genesis,
      label: n.label ?? '', labelAt: genesis, icon: n.icon ?? '', iconAt: genesis,
      color: n.color ?? 'terracotta', colorAt: genesis,
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

  // Load the durable lattice from IndexedDB (renders offline immediately), then connect.
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
    this.store.requestPersistent().then((granted) => { if (!granted) this.durabilityAtRisk = true; });
    if (typeof window !== 'undefined') {
      this.pagehide = () => this.persistNow();
      window.addEventListener('pagehide', this.pagehide);
    }
    this.connect();
    return this;
  }

  connect() {
    clearTimeout(this.reconnectTimer);
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('open', () => {
      this.phase = 'syncing';
      // Send our coverage so the server replies with only the gap (two-way anti-entropy, §6).
      this.ws.send(JSON.stringify({ t: 'subscribe', treeId: this.treeId, lastSeq: this.lastSeq, vector: this.ackedServerVector.toJSON() }));
    });
    this.ws.addEventListener('message', (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      this.receive(frame);
    });
    this.ws.addEventListener('close', () => {
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

  receive(frame) {
    // Only the subscribe reply ('delta') may re-baseline coverage. Everything else on the
    // broadcast channel — 'live', an echoed 'flush', an import 'graft' — is a seq'd delta:
    // re-baselining on one would REPLACE coverage with that frame's own frontier, uncovering
    // everything else and re-flushing it forever (the echo ping-pong).
    if (frame.t === 'subgraph') return frame.intent === 'delta' ? this.receiveState(frame) : this.receiveLive(frame);
    if (frame.t === 'subgraphAck') return this.receiveAck(frame);
    if (frame.t === 'skew') return this.receiveSkew(frame);
    if (frame.t === 'presence') return void this.presenceHandler?.(frame);
    if (frame.t === 'peer') return void this.peerHandler?.(frame);
    if (frame.t === 'progress') return void this.progressHandler?.(frame);
    if (frame.t === 'reject') return this.receiveReject(frame);
  }

  // The subscribe response: the server's delta for the vector we sent (a fresh client gets the
  // whole state). Re-baselines coverage and seq, then flushes whatever the server is missing.
  // This is the only channel that advances coverage wholesale — and only from content just
  // joined, so it can never outrun content. A delta states the server's full frontier as its
  // coverage; a bare graft (no coverage — e.g. an HTTP bootstrap) is a full state, so the join
  // frontier is that frontier.
  receiveState(frame) {
    let frontier;
    try { frontier = this.lattice.join(frame); } catch { this.forceReconnect(); return; }
    for (const [actor, m] of frontier.marks) this.clock.observe({ ms: m.ms, counter: m.counter, actor });
    if (typeof frame.seq === 'number') this.lastSeq = frame.seq;
    this.ackedServerVector = frame.coverage ? VersionVector.fromJSON(frame.coverage) : frontier;  // REPLACE
    this.persistNow();
    this.ready = true;
    this.emitTree();
    this.flush();
    this.phase = 'live';
    this.backoffMs = 500;
    this.liveHandler?.();  // each graft is a fresh baseline — the view reconciles progress off it
    this.noteDrained();    // an empty flush means the server already covers everything
  }

  // A live broadcast (ours echoed back, a collaborator's, or an MCP edit). Dense-seq gated;
  // never touches coverage.
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

  // The claim sequence (anon-first-tree F4) waits on this: fired whenever the wire goes
  // idle with full coverage — live, nothing pending, nothing in flight.
  noteDrained() {
    if (this.phase !== 'live' || this.inFlight.size > 0) return;
    if (this.pendingEditCount() > 0) return;
    this.drainedHandler?.();
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
    const forbidden = frame.reason === 'sign in to edit'
      || frame.reason === 'sign in to track progress'
      || frame.reason === 'this tree belongs to another account';
    if (!forbidden) { console.warn('[sync] frame rejected —', frame.reason); return; }
    if (frame.reason !== 'sign in to track progress') this.durabilityAtRisk = true; // banked edits stranded until the capability returns
    window.dispatchEvent(new CustomEvent('wm-edit-forbidden', { detail: frame.reason }));
  }

  emitTree() { this.treeHandler?.(this.lattice.toTreeData()); }

  // How much of the bank the server does not hold — what the honesty chrome counts.
  pendingEditCount() {
    const pending = this.lattice.deltaSince(this.ackedServerVector);
    return pending.nodes.length + pending.edges.length + pending.kinds.length + (pending.title ? 1 : 0);
  }

  // Everything the server does not yet cover — the offline outbox, derived not queued.
  flush() {
    const pending = this.lattice.deltaSince(this.ackedServerVector);
    if (!pending.nodes.length && !pending.edges.length && !pending.kinds.length && !pending.title) return;
    for (const chunk of chunkDelta(pending)) this.send(chunk, 'flush');
  }

  // A local edit: materialize → journal its inverse → join → render → persist → send if live.
  dispatch(gesture) {
    if (!this.ready) return;
    const writes = materialize(gesture, this.lattice, this.clock);
    if (!writes.nodes.length && !writes.edges.length && !writes.kinds.length) return;
    this.undoStack.push(this.captureInverse(writes));
    this.redoStack = [];
    this.apply(writes);
  }

  // Rename the tree: one stamped write to the title register, joined + persisted + sent like
  // any field change (LWW against concurrent renames; banked in the outbox while offline).
  // Not a canvas gesture, so it stays out of the undo journal. Returns whether the session
  // took the write — before the durable lattice loads it can't, and the caller must PATCH
  // instead so the rename is never silently lost.
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

  // Persist the whole lattice + lastSeq atomically. Snapshot is synchronous (before any await);
  // a save failure degrades durability honestly but never blocks liveness. A closed session
  // never writes — deleting a tree relies on the blob staying gone. The device-tree index is
  // touched alongside, so every persisting tree lists in the switcher — signed out included.
  // Returns the save's settle, for callers that must be durable before navigating.
  persistNow() {
    if (this.closed) return Promise.resolve();
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const value = { frame: this.lattice.toFrame(), lastSeq: this.lastSeq };
    this.registry?.touch(this.treeId, this.lattice.title);
    return this.store.save(this.treeId, value).catch(() => { this.durabilityAtRisk = true; });
  }

  // Coalesced save for the receive path — received content is already server-durable, so lagging
  // the blob a beat only risks over-fetching via the next graft, never a lost or poisoned write.
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.persistNow(); }, 250);
  }

  captureInverse(writes) {
    const nodes = (writes.nodes ?? []).map((n) => {
      const record = this.lattice.nodes.get(n.id);
      const inv = { id: n.id };
      if (n.createdAt) inv.deleteLife = true;   // undo a create → tombstone
      if (n.deletedAt) inv.addLife = true;      // undo a delete → re-add (fields survive in the lattice)
      if ('labelAt' in n) inv.label = record ? record.label.v : '';
      if ('iconAt' in n) inv.icon = record ? record.icon.v : '';
      if ('colorAt' in n) inv.color = record ? record.color.v : 'terracotta';
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

  // Progress rides the socket but not the lattice: no outbox, no ack — an offline mark
  // reaches the server via the view's reconciliation on the next graft.
  sendProgress(nodeId, status) {
    if (this.phase !== 'live' || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ t: 'progress', treeId: this.treeId, nodeId, status }));
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

  // The ids a paste graft must reserve against collision — present AND tombstoned, so a
  // colliding slug never resurrects a deleted node (F3 §01).
  knownNodeIds() { return this.lattice.knownNodeIds(); }

  // Device-to-device by file (the `.windmill` sneakernet): the whole lattice as one graft
  // document. Tombstones ride along, so even deletions travel by AirDrop/QR/disk.
  exportGraft() {
    return { format: 'windmill-tree', v: 1, treeId: this.treeId, title: this.lattice.title, exportedAt: Date.now(), frame: this.lattice.toFrame() };
  }

  // Import a `.windmill` document. Same tree → join the stamps verbatim (a device catching up;
  // state-only, so it never advances coverage — the merged content flushes to the server on the
  // next sync). Different tree → a subtree gift: restamp every present node as fresh local
  // authorship with remapped ids, so foreign stamps never enter this tree's coverage space.
  importGraft(doc) {
    if (!doc || doc.format !== 'windmill-tree' || !doc.frame) return { ok: false, reason: 'not a windmill tree file' };
    if (doc.treeId === this.treeId) {
      try { this.lattice.join(doc.frame); } catch { return { ok: false, reason: 'corrupt tree file' }; }
      this.emitTree();
      this.persistNow();
      if (this.phase === 'live') this.flush();
      return { ok: true, mode: 'merged' };
    }
    return this.importGift(doc);
  }

  importGift(doc) {
    const source = new TreeLattice(doc.treeId);
    try { source.join(doc.frame); } catch { return { ok: false, reason: 'corrupt tree file' }; }
    const data = source.toTreeData();
    const remap = new Map();
    for (const n of data.nodes) remap.set(n.id, `gift-${crypto.randomUUID?.().slice(0, 8) ?? Date.now()}`);
    for (const n of data.nodes) {
      this.dispatch({ kind: 'CreateNode', id: remap.get(n.id), label: n.label, icon: n.icon, color: n.color, x: n.position?.x, y: n.position?.y, description: n.description, links: n.links });
    }
    for (const n of data.nodes) for (const p of n.prerequisites) {
      if (remap.has(p)) this.dispatch({ kind: 'AddEdge', from: remap.get(p), to: remap.get(n.id) });
    }
    return { ok: true, mode: 'gifted', count: data.nodes.length };
  }

  clearDurable() { this.store.clear(this.treeId).catch(() => {}); }

  close() {
    this.closed = true;
    if (this.pagehide) {
      window.removeEventListener('pagehide', this.pagehide);
      this.pagehide = null;
    }
    clearTimeout(this.presenceTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.saveTimer);
    this.presenceTimer = this.reconnectTimer = this.saveTimer = null;
    this.ws?.close();
    this.ws = null;
  }
}

// Split an oversized flush by entry count so no single frame exceeds the server's byte cap.
// Each chunk is an independently valid subgraph — joins compose, so no flushId ceremony is
// needed. The title (one register) rides the first chunk.
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
