// The outbox is each lattice register newer than its confirmed baseline, minus the same stamp already in flight.
// The structure vector only reduces subscribe grafts; own structure echoes do not confirm.
// Dense sequence numbers gate live structure frames; a gap or malformed structure frame forces a resubscribe.

import { pageWatching, reportInvalidProgressMark, reportRoadmapFailure } from '../reportFailure.js';
import { socketUrl } from '../../../shell/apiBase.js';
import { HlcClock, NODE_REGISTERS, TREE_REGISTERS, TreeLattice, UNWRITTEN_NODE, VersionVector, hlcText, parseHlc } from './lattice.js';
import { ProgressLattice } from './progressLattice.js';
import { materialize } from './materialize.js';
import { MAX_FRAME_BYTES, UNSENDABLE_FROM_BYTES, bytesOf, frameRoom, framesOf, stampedPerFrame, stampsOf } from './frames.js';
import { UNSENDABLE, isOwnershipRefusal, isSessionRefusal, strandsTheBank } from './refusals.js';
import { SyncStore } from './SyncStore.js';
import { frameWrites, outboxStamps, outboxWrites, pendingGestures, pendingRecordCount, retainedGestures, writeStamps } from './pendingWrites.js';
import { LocalTreeRegistry } from '../persistence/LocalTreeRegistry.js';
import { ProgressStore } from '../persistence/ProgressStore.js';
import { GENESIS_STAMP } from '../model/Legend.js';
import { InadmissibleGuide, admitsGuide } from '../guide/GuideDraft.js';

const DEFAULT_URL = socketUrl();
const MAX_BACKOFF_MS = 8000;
const FIRST_RESEND_MS = 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;
// Sockets lost running with the lane's first frame unanswered before that frame is judged one this browser cannot
// send.
const UNANSWERED_CLOSES_LIMIT = 5;
const HEARTBEAT_MS = 20000;
// Dead-socket detection counts consecutive unanswered pings, not wall-clock silence: a
// backgrounded tab's setInterval throttles to ~once/60s. STALE_MS is only for the wake/online path.
const MISSED_PINGS_LIMIT = 3;   // pings unanswered in a row ⇒ half-open ⇒ reconnect (≈60s foreground)
const STALE_MS = 60000;         // on refocus or network return, a minute of silence ⇒ reconnect
const SOCKET_FAILING_MS = 10000; // no answer for this long, online and in view, is a failure worth one report

function replicaActor() {
  const nonce = crypto.randomUUID?.().slice(0, 8) ?? `${Date.now()}`;
  return `r_${nonce}`;  // one fresh replica identity per tab, so stamps never collide across tabs
}

function frameFrontier(writes) {
  return new TreeLattice().join(writes);  // join returns the frontier of a frame's stamps
}

function writesNothing(writes) {
  return !writes.nodes.length && !writes.edges.length && !writes.kinds.length && TREE_REGISTERS.every((name) => !writes[name]);
}

export class SyncSession {
  constructor({ url = DEFAULT_URL, treeId, title = '', guide = '', registry = new LocalTreeRegistry(), store = new SyncStore(),
    reportFailure = reportRoadmapFailure, chunkBytes = MAX_FRAME_BYTES, timers = globalThis } = {}) {
    this.url = url;
    this.timers = timers;
    this.resendTimers = { structure: null, progress: null };
    this.skewTimers = { structure: null, progress: null };
    this.resendBackoffMs = { structure: FIRST_RESEND_MS, progress: FIRST_RESEND_MS };
    this.pingBoundaries = [];
    this.reportFailure = reportFailure;
    this.reportInvalidProgressMark = () => reportInvalidProgressMark(this.reportFailure);
    this.treeId = treeId;
    this.actor = replicaActor();
    this.room = frameRoom(treeId, this.actor, chunkBytes);  // the bytes one frame leaves for its writes
    this.clock = new HlcClock(this.actor);
    this.lattice = new TreeLattice(treeId, title, guide);  // the doc's title and guide are stampless baselines; any stamped write dominates
    // This account's own marks: same clock and same blob as the structure, never the same frame.
    this.progress = new ProgressLattice();
    this.confirmedStructure = new TreeLattice(treeId, title, guide);
    this.confirmedProgress = new ProgressLattice();
    this.confirmedKnown = { structure: false, progress: false };
    this.gestures = { structure: {}, progress: {} };
    this.epochs = { structure: 0, progress: 0 };
    this.unsubscribeEpochs = null;
    this.store = store;
    this.registry = registry;                       // the device-tree index persistNow keeps fresh; null for read-only views
    this.ackedServerVector = new VersionVector();  // in-memory subscribe frontier, never delivery truth
    this.inFlight = new Map();                      // frameId -> sent structure writes
    this.progressInFlight = new Map();              // frameId -> sent progress writes
    this.ws = null;
    this.sending = new Set();                       // sends waiting on their epoch read; the socket outlasts them
    this.leaving = false;                           // the page is going: no callback will ever run again
    this.heldAct = null;                            // what Undo takes back before the stack: a held delete
    this.reported = new Set();
    this.unansweredSince = null;                    // when this socket began going unanswered; any inbound frame clears it
    this.phase = 'offline';                         // offline | syncing | live
    this.ready = false;
    this.joinedServer = false;                      // the server's state has joined this lattice since the session began
    this.reach = null;                              // 'writer' or 'reader': what the server last took this connection for
    this.confirmations = 0;                         // structure the server has confirmed: acks, grafts and peers' frames
    this.leadNowhere = new Map();                   // step → the pointer the room found leading to no tree: its mark is owed
    this.lastSeq = 0;
    this.fullGraftPending = false;
    this.sent = new Set();                          // frameIds we authored — echoes already applied
    this.durabilityAtRisk = false;
    this.backoffMs = 500;
    this.reconnectTimer = null;
    this.saveTimer = null;
    this.undoStack = [];
    this.redoStack = [];
    this.receipts = new WeakMap();
    this.treeHandler = null;
    this.presenceHandler = null;
    this.peerHandler = null;
    this.progressHandler = null;
    this.drainedHandler = null;
    this.confirmedHandler = null;
    this.presence = null;
    this.presenceTimer = null;
    this.pagehide = null;
    this.pageshow = null;
    this.heartbeatTimer = null;
    this.lastRecvAt = 0;        // Date.now() of the last inbound frame — the wake/online staleness clock
    this.pingsSinceRecv = 0;    // consecutive pings with no inbound frame since
    this.onVisible = null;  // refocus reconnect
    this.onOnline = null;   // network-return reconnect
    this.closed = false;
    this.statusHandlers = new Set();
    this.refusalHandlers = new Set();
    this.online = typeof navigator === 'undefined' || navigator.onLine !== false;
    this.refusals = new Map();
    this.refusalEpisodes = new Map();
    this.dropped = { stamp: null, closes: 0 };      // sockets lost running with the frame of this first stamp unanswered
    this.unsendable = new Set();                    // stamps of a frame judged unsendable: held until Retry
    this.receiptVersion = 0;
    this.rebaselining = null;
    this.discardPending = false;
    this.deferredSave = false;
    this.status = null;
    this.onOffline = null;
  }

  onTreeChanged(handler) { this.treeHandler = handler; return this; }
  onPresence(handler) { this.presenceHandler = handler; return this; }
  onPeer(handler) { this.peerHandler = handler; return this; }
  onProgress(handler) { this.progressHandler = handler; return this; }
  onDrained(handler) { this.drainedHandler = handler; return this; }
  onConfirmed(handler) { this.confirmedHandler = handler; return this; }

  // Only a writer's answer speaks for the trees steps open: the server hides them from anyone else.
  get writesPointers() { return this.reach === 'writer'; }

  // The steps whose pointer this device wrote and the server has not confirmed.
  ownPointers() {
    return new Set(Object.keys(this.unconfirmedWrites('structure')).flatMap((key) => {
      const [section, id, field] = JSON.parse(key);
      return section === 'nodes' && field === 'opensAt' ? [id] : [];
    }));
  }

  // The server confirmed structure: one more round for whoever reads what a confirmation made true.
  noteConfirmed() {
    this.confirmations += 1;
    try {
      this.confirmedHandler?.();
    } catch (error) {
      this.reportFailure('roadmap-sync-notify', error);
    }
  }

  subscribeStatus(handler) {
    this.statusHandlers.add(handler);
    this.status = this.statusSnapshot();
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  subscribeRefusals(handler) {
    this.refusalHandlers.add(handler);
    for (const refusal of this.refusals.values()) handler(refusal);
    return () => this.refusalHandlers.delete(handler);
  }

  statusSnapshot() {
    const confirmed = { structure: writeStamps(this.confirmedStructure.toFrame()), progress: writeStamps(this.confirmedProgress.toFrame()) };
    const pending = (lane, frame) => pendingRecordCount(outboxStamps(writeStamps(frame), confirmed[lane]));
    const structurePending = this.rebaselining?.has('structure') ? 0 : pending('structure', this.lattice.toFrame());
    const owedProgress = this.owedFrames('progress').frame;
    const progressPending = this.rebaselining?.has('progress') ? 0 : pending('progress', owedProgress);
    const inFlightCount = (lane, frames) => [...frames.values()].filter((frame) => pending(lane, frame) > 0).length;
    const snapshot = {
      phase: this.phase,
      online: this.online,
      structurePending,
      progressPending,
      structureInFlight: this.rebaselining?.has('structure') ? 0 : inFlightCount('structure', this.inFlight),
      progressInFlight: this.rebaselining?.has('progress') ? 0 : inFlightCount('progress', this.progressInFlight),
      structureGestures: this.rebaselining?.has('structure') ? 0 : Object.keys(this.gestures.structure).length,
      progressGestures: this.rebaselining?.has('progress') ? 0 : Object.keys(retainedGestures('progress', owedProgress, this.gestures.progress)).length,
      rebaselining: this.rebaselining != null,
      refused: this.refusals.values().next().value ?? null,
      receiptVersion: this.receiptVersion,
    };
    if (this.status && Object.keys(snapshot).every((key) => this.status[key] === snapshot[key])) return this.status;
    return Object.freeze(snapshot);
  }

  emitStatus() {
    if (!this.statusHandlers.size) return;
    const previous = this.status;
    const snapshot = this.statusSnapshot();
    if (snapshot === previous) return;
    this.status = snapshot;
    for (const handler of this.statusHandlers) handler(snapshot);
  }

  // The person says to send what was refused again: what was held goes, as it was stamped, with the flush the reconnect
  // brings.
  retry() {
    this.refusals.clear();
    this.dropped = { stamp: null, closes: 0 };
    this.unsendable.clear();
    this.emitStatus();
    this.forceReconnect();
  }

  async discard() {
    const refused = this.refusals.values().next().value;
    if (!refused || this.rebaselining || this.discardPending) return false;
    const lane = refused.lane;
    if (!this.confirmedKnown[lane]) return false;
    const shown = this.unconfirmedWrites(lane);
    const previousReady = this.ready;
    this.ready = false;
    this.rebaselining = new Set([lane]);
    this.discardPending = true;
    this.timers.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.forceReconnect();
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.phase = this.online ? 'syncing' : 'offline';
    this.refusals.delete(lane);
    this.emitProjection(lane);
    this.emitStatus();
    let result;
    try {
      result = await this.store.replaceLane(this.treeId, lane, this.epochs[lane], shown);
    } catch (error) {
      this.ready = previousReady;
      this.rebaselining = null;
      this.discardPending = false;
      this.refusals.set(lane, refused);
      this.emitProjection(lane);
      this.emitStatus();
      this.reportFailure('roadmap-sync-discard', error);
      await this.persistDeferred();
      if (!this.closed) this.scheduleReconnect();
      return false;
    }
    this.discardPending = false;
    this.rebaselining = null;
    if (result.status === 'unavailable') {
      this.ready = previousReady;
      this.refusals.set(lane, refused);
      this.emitProjection(lane);
      this.emitStatus();
      await this.persistDeferred();
      if (!this.closed) this.scheduleReconnect();
      return false;
    }
    this.adoptEpochs(result.value, { discarding: result.status === 'replaced' });
    if (result.notificationError) this.reportFailure('roadmap-sync-notify', result.notificationError);
    await this.persistDeferred();
    return result.status === 'replaced';
  }

  laneFrames(lane) {
    return lane === 'structure'
      ? { frame: this.lattice.toFrame(), confirmed: this.confirmedStructure.toFrame() }
      : { frame: this.progress.toFrame(), confirmed: this.confirmedProgress.toFrame() };
  }

  // What a lane owes the server, beside its confirmed baseline: all of the structure, and every mark but those set
  // aside. A mark on a step that opens a tree stays on the device as it is, and while the pointer stands it is neither
  // sent nor counted as unsent; with the pointer gone, or once the room has found that it leads to no tree, it is an
  // ordinary mark again.
  owedFrames(lane) {
    const { frame, confirmed } = this.laneFrames(lane);
    if (lane === 'structure') return { frame, confirmed };
    return { frame: { marks: frame.marks.filter(({ node }) => this.markOwed(node)) }, confirmed };
  }

  // Whether a step's mark is an ordinary one: it holds no pointer, or the pointer it holds is one the room found leading
  // to no tree. A pointer nothing was found of keeps its mark set aside.
  markOwed(stepId) {
    const opens = this.lattice.nodes.get(stepId)?.opens.v;
    return !opens || this.leadNowhere.get(stepId) === opens;
  }

  // The pointers the room found leading to no tree, by step, as its facts read them: the device's rule on a tree that
  // lives only here, the server's on any other. A mark on such a step is owed like any other, and one newly owed goes.
  pointersLeadNowhere(pointers) {
    const released = [...pointers].some(([step, tree]) => this.leadNowhere.get(step) !== tree);
    this.leadNowhere = new Map(pointers);
    if (released && this.canResend('progress')) this.flushProgress();
    this.emitStatus();
  }

  unconfirmedWrites(lane) {
    const { frame, confirmed } = this.owedFrames(lane);
    return outboxStamps(writeStamps(frame), writeStamps(confirmed));
  }

  // What this tab wrote and the server does not hold: another tab's discard took only what that tab showed.
  ownUnsentWrites(lane) {
    const { frame, confirmed } = this.laneFrames(lane);
    return frameWrites(outboxWrites(frame, confirmed), (key, stamp) => parseHlc(stamp).actor === this.actor);
  }

  adoptEpochs(value, { discarding = false } = {}) {
    if (this.closed || !value) return;
    const changed = ['structure', 'progress'].filter((lane) => value.epochs[lane] > this.epochs[lane]);
    if (!changed.length) return;
    this.clearDeliveryTimers();
    const kept = discarding ? {} : Object.fromEntries(changed.map((lane) => [lane, this.ownUnsentWrites(lane)]));
    this.ready = false;
    this.rebaselining = new Set([...(this.rebaselining ?? []), ...changed]);
    for (const lane of changed) {
      this.epochs[lane] = value.epochs[lane];
      this.refusals.delete(lane);
      this.refusalEpisodes.delete(lane);
      this.confirmedKnown[lane] = value.confirmed[lane] != null;
      if (lane === 'structure') {
        const confirmed = this.confirmedStructure;
        this.lattice = confirmed.baseline();
        this.lattice.join(value.frame);
        if (kept.structure) this.lattice.join(kept.structure);
        this.confirmedStructure = confirmed.baseline();
        if (value.confirmed.structure) this.confirmedStructure.join(value.confirmed.structure);
        this.ackedServerVector = new VersionVector();
        this.inFlight.clear();
        this.sent.clear();
        this.lastSeq = 0;
      } else {
        this.progress = new ProgressLattice();
        this.progress.join(value.progress, this.reportInvalidProgressMark);
        if (kept.progress) this.progress.join(kept.progress);
        this.confirmedProgress = new ProgressLattice();
        if (value.confirmed.progress) this.confirmedProgress.join(value.confirmed.progress, this.reportInvalidProgressMark);
        this.progressInFlight.clear();
      }
      const { frame, confirmed } = this.laneFrames(lane);
      this.gestures[lane] = pendingGestures(frame, confirmed);
    }
    this.undoStack = [];
    this.redoStack = [];
    this.receipts = new WeakMap();
    this.receiptVersion += 1;
    for (const lane of changed) this.emitProjection(lane);
    this.phase = this.online ? 'syncing' : 'offline';
    this.emitStatus();
    if (changed.some((lane) => Object.keys(writeStamps(kept[lane])).length)) this.persistWrite();
    this.forceReconnect();
    if (!this.closed) this.scheduleReconnect();
  }

  // Seed a local-only lattice from projected TreeData: every field takes a genesis stamp, so any
  // later edit dominates it. No socket, no IndexedDB.
  seed(treeData) {
    const genesis = GENESIS_STAMP;
    const nodes = treeData.nodes.map((n) => ({
      id: n.id, createdAt: genesis,
      label: n.label ?? '', labelAt: genesis, icon: n.icon ?? '', iconAt: genesis,
      color: n.color ?? 'terracotta', colorAt: genesis,
      order: n.order ?? '', orderAt: genesis,
      ...(n.status ? { status: n.status, statusAt: genesis } : {}),
      ...(n.description ? { description: n.description, descriptionAt: genesis } : {}),
      ...(n.links?.length ? { links: n.links, linksAt: genesis } : {}),
      ...(n.opens ? { opens: n.opens, opensAt: genesis } : {}),
    }));
    const edges = [];
    for (const n of treeData.nodes) for (const p of n.prerequisites ?? []) edges.push({ from: p, to: n.id, addedAt: genesis });
    const kinds = (treeData.kinds ?? []).map((k, i) => ({
      id: k.id, createdAt: genesis, hue: k.hue, hueAt: genesis,
      label: k.label ?? '', labelAt: genesis, description: k.description ?? '', descriptionAt: genesis,
      rank: i, rankAt: genesis,
    }));
    this.lattice = new TreeLattice(treeData.id, treeData.title, treeData.guide ?? '');
    this.lattice.join({ nodes, edges, kinds });
    this.lattice.seedClock(this.clock);
    this.ready = true;
    this.emitTree();
    this.emitStatus();
  }

  async start() {
    try {
      this.unsubscribeEpochs = this.store.subscribeEpochs?.(this.treeId, ({ lane, epoch }) => {
        if (this.closed || this.discardPending || epoch <= this.epochs[lane]) return;
        this.store.load(this.treeId).then((value) => this.adoptEpochs(value)).catch((error) => {
          this.durabilityAtRisk = true;
          this.reportFailure('roadmap-sync-persist', error);
        });
      });
    } catch (error) {
      this.reportFailure('roadmap-sync-notify', error);
    }
    // What the store cannot read stays out, and the server's graft fills it; a join validates before it mutates.
    const unreadable = (error) => {
      this.durabilityAtRisk = true;
      this.reportOnce('roadmap-sync-restore', error);
    };
    const restored = (lattice, frame) => {
      if (!frame) return false;
      try {
        lattice.join(frame, this.reportInvalidProgressMark);
        return true;
      } catch (error) {
        unreadable(error);
        return false;
      }
    };
    let saved = null;
    try { saved = await this.store.load(this.treeId); } catch (error) { unreadable(error); }
    if (saved?.epochs) this.epochs = { ...saved.epochs };
    if (restored(this.confirmedStructure, saved?.confirmed?.structure)) this.confirmedKnown.structure = true;
    if (restored(this.confirmedProgress, saved?.confirmed?.progress)) this.confirmedKnown.progress = true;
    if (restored(this.lattice, saved?.frame)) {
      this.lastSeq = saved.lastSeq ?? 0;
      this.lattice.seedClock(this.clock);
      this.ready = true;
      this.emitProjection('structure');
    }
    restored(this.progress, saved?.progress);
    const restoredFrame = this.lattice.toFrame();
    this.gestures.structure = pendingGestures(saved?.gestures?.structure ? {} : restoredFrame, this.confirmedStructure.toFrame(),
      retainedGestures('structure', restoredFrame, saved?.gestures?.structure));
    // localStorage residue folds in uncovered, so the first graft flushes it.
    if (this.registry) new ProgressStore().drainInto(this.treeId, this.progress, this.reportInvalidProgressMark);
    this.gestures.progress = pendingGestures(this.progress.toFrame(), this.confirmedProgress.toFrame(), retainedGestures('progress', this.progress.toFrame(), saved?.gestures?.progress));
    if (this.progress.marks.size) {
      this.progress.seedClock(this.clock);
      this.emitProjection('progress');
    }
    this.store.requestPersistent().then((granted) => { if (!granted) this.durabilityAtRisk = true; });
    this.online = typeof navigator === 'undefined' || navigator.onLine !== false;
    if (typeof window !== 'undefined') {
      this.pagehide = () => { if (!this.leaving) this.persistNow(); };
      this.pageshow = () => { this.leaving = false; };
      window.addEventListener('pagehide', this.pagehide);
      window.addEventListener('pageshow', this.pageshow);
      // A sleep/wake or network flap can leave the socket half-open: OPEN, no bytes, no `close`.
      this.onVisible = () => { if (document.visibilityState === 'visible') this.reconnectIfStale(); };
      this.onOnline = () => {
        this.online = true;
        this.unansweredSince = null;
        this.emitStatus();
        this.reconnectIfStale();
      };
      this.onOffline = () => {
        this.online = false;
        this.unansweredSince = null;
        this.emitStatus();
      };
      document.addEventListener('visibilitychange', this.onVisible);
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
    }
    this.emitStatus();
    this.connect();
    return this;
  }

  connect() {
    this.timers.clearTimeout(this.reconnectTimer);
    this.clearDeliveryTimers();
    this.inFlight.clear();
    this.progressInFlight.clear();
    this.unansweredSince ??= Date.now();
    const socket = new WebSocket(this.url);
    this.ws = socket;
    socket.addEventListener('open', () => {
      if (this.closed || this.discardPending || this.ws !== socket) return;
      this.phase = 'syncing';
      this.emitStatus();
      this.fullGraftPending = this.ackedServerVector.marks.size === 0;
      // Send our coverage so the server replies with only the gap.
      this.ws.send(JSON.stringify({ t: 'subscribe', treeId: this.treeId, lastSeq: this.lastSeq, vector: this.ackedServerVector.toJSON() }));
      this.startHeartbeat();
    });
    socket.addEventListener('message', (event) => {
      if (this.closed || this.discardPending || this.ws !== socket) return;
      this.lastRecvAt = Date.now();  // any inbound frame proves the pipe is alive — bump before parse
      this.pingsSinceRecv = 0;
      this.unansweredSince = null;
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch (error) {
        this.reportOnce('roadmap-sync-frame', error);
        return;
      }
      this.receive(frame);
    });
    socket.addEventListener('close', () => {
      if (this.ws !== socket) return;
      this.stopHeartbeat();
      this.phase = this.rebaselining && this.online ? 'syncing' : 'offline';
      this.clearDeliveryTimers();
      this.noteDropped();
      this.inFlight.clear();
      this.progressInFlight.clear();
      this.emitStatus();
      this.noteUnanswered();
      if (!this.closed && !this.discardPending) this.scheduleReconnect();
    });
    socket.addEventListener('error', () => { try { socket.close(); } catch { /* close handler reconnects */ } });
    return this;
  }

  // A socket lost with structure frames unanswered. The judgement is of one frame, the lane's first, whatever is queued
  // behind it: lost unanswered with UNANSWERED_CLOSES_LIMIT sockets running, and past the size any healthy path
  // carries, it is a frame the path drops the connection for — a message past a size limit is refused that way, with
  // no word. It stands refused as a write this browser cannot send and is reported once. Its stamps are held, and with
  // them every other stamp of the acts it carries, so no part of an act lands while another is held: not sent again
  // until Retry, while every other write goes on. A smaller frame is retried with each socket, without limit.
  noteDropped() {
    const head = this.inFlight.values().next().value;
    if (!head) return;
    const bytes = bytesOf(head);
    const stamp = stampsOf(head)[0];
    if (bytes <= UNSENDABLE_FROM_BYTES) {
      this.dropped = { stamp: null, closes: 0 };
      return;
    }
    this.dropped = { stamp, closes: this.dropped.stamp === stamp ? this.dropped.closes + 1 : 1 };
    if (this.dropped.closes !== UNANSWERED_CLOSES_LIMIT) return;
    const judged = new Set(stampsOf(head));
    for (const references of Object.values(this.gestures.structure)) {
      const ofAct = Object.values(references);
      if (ofAct.some((written) => judged.has(written))) for (const written of ofAct) this.unsendable.add(written);
    }
    for (const written of judged) this.unsendable.add(written);
    this.durabilityAtRisk = true;
    const refusal = this.standRefusal('structure', UNSENDABLE);
    for (const handler of this.refusalHandlers) handler(refusal);
    const size = bytes < 128 * 1024 ? 'under-128k' : bytes < 256 * 1024 ? 'under-256k' : bytes < 1024 * 1024 ? 'under-1m' : 'over-1m';
    this.reportOnce('roadmap-sync-unlandable', new Error('Roadmap frame dropped with its socket'), { lane: 'structure', size });
  }

  // A socket that stays unanswered, online and in view, is broken; being offline or hidden is not a failure.
  noteUnanswered() {
    if (this.unansweredSince === null || Date.now() - this.unansweredSince < SOCKET_FAILING_MS) return;
    if (this.online && pageWatching()) this.reportOnce('roadmap-sync-socket', new Error('Roadmap socket unanswered'));
  }

  reportOnce(operation, error, tags) {
    if (this.reported.has(operation)) return;
    this.reported.add(operation);
    this.reportFailure(operation, error, tags);
  }

  scheduleReconnect() {
    this.timers.clearTimeout(this.reconnectTimer);
    const wait = this.backoffMs * (0.5 + Math.random() * 0.5);  // full jitter
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = this.timers.setTimeout(() => this.connect(), wait);
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
    this.heartbeatTimer = this.timers.setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;  // the close handler owns reconnection while not open
      this.noteUnanswered();
      const boundary = { structure: [...this.inFlight.keys()].at(-1), progress: [...this.progressInFlight.keys()].at(-1) };
      this.pingBoundaries.push(boundary);
      try {
        this.ws.send(JSON.stringify({ t: 'ping', treeId: this.treeId }));
      } catch (error) {
        this.reportFailure('roadmap-sync-send', error);
        this.forceReconnect();
        return;
      }
      this.pingsSinceRecv += 1;
      if (this.pingsSinceRecv >= MISSED_PINGS_LIMIT || this.pingBoundaries.length >= MISSED_PINGS_LIMIT) this.forceReconnect();
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    this.timers.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  reconnectIfStale() {
    if (this.ws?.readyState !== WebSocket.OPEN || Date.now() - this.lastRecvAt > STALE_MS) this.forceReconnect();
  }

  receive(frame) {
    if (this.discardPending || this.closed) return;
    if (frame.t === 'pong') {
      const boundary = this.pingBoundaries.shift();
      if (!boundary) return;
      for (const lane of ['structure', 'progress']) this.settleUnanswered(lane, boundary[lane], true);
      this.emitStatus();
      return;
    }
    if (frame.t === 'ping') return;
    // Only the subscribe reply ('delta') may re-baseline coverage.
    if (frame.t === 'subgraph') return frame.intent === 'delta' ? this.receiveState(frame) : this.receiveLive(frame);
    if (frame.t === 'subtree') return this.receiveSubtree(frame);
    if (frame.t === 'subgraphAck') return this.receiveAck(frame);
    if (frame.t === 'skew') return this.receiveSkew(frame);
    if (frame.t === 'presence') return void this.presenceHandler?.(frame);
    if (frame.t === 'peer') return void this.peerHandler?.(frame);
    // Progress grafts replace the confirmed overlay; durable echoes join it.
    if (frame.t === 'progress') return frame.intent === 'graft' ? this.receiveProgressGraft(frame) : this.receiveProgress(frame);
    if (frame.t === 'progressAck') return this.receiveProgressAck(frame);
    if (frame.t === 'reject') return this.receiveReject(frame);
  }

  // A subscribe graft replaces the subscribe frontier and seq, then flushes unconfirmed registers. Its `reach` says whether
  // the server takes this connection for a writer of the tree; an answer without one is a reader's.
  receiveState(frame) {
    const reach = frame.reach === 'writer' ? 'writer' : 'reader';
    if (!this.fullGraftPending && typeof frame.seq === 'number' && frame.seq < this.lastSeq) {
      this.ackedServerVector = new VersionVector();
      this.forceReconnect();
      return;
    }
    // A reader's coverage counts pointers it was never shown, so a reader turned writer asks again from nothing.
    if (!this.fullGraftPending && reach === 'writer' && this.reach === 'reader') {
      this.ackedServerVector = new VersionVector();
      this.forceReconnect();
      return;
    }
    let frontier;
    let coverage;
    try {
      frontier = this.lattice.join(frame);
      coverage = frame.coverage ? VersionVector.fromJSON(frame.coverage) : frontier;
      if (this.fullGraftPending) {
        // A writer's full graft is the server's word on every register, pointers included. A reader's is silent on
        // pointers, so the ones the server confirmed before stay confirmed.
        const confirmedPointers = reach === 'writer' ? null : this.confirmedStructure.pointers();
        this.confirmedStructure = this.confirmedStructure.baseline();
        if (confirmedPointers) this.confirmedStructure.join(confirmedPointers);
      }
      this.confirmedStructure.join(frame);
      if (this.fullGraftPending) this.gestures.structure = pendingGestures(this.lattice.toFrame(), this.confirmedStructure.toFrame(), this.gestures.structure);
      else this.confirm('structure');
    } catch (error) {
      this.reportOnce('roadmap-sync-frame', error);
      this.forceReconnect();
      return;
    }
    for (const [actor, m] of frontier.marks) this.clock.observe({ ms: m.ms, counter: m.counter, actor });
    if (typeof frame.seq === 'number') this.lastSeq = frame.seq;
    this.ackedServerVector = coverage;
    this.fullGraftPending = false;
    this.confirmedKnown.structure = true;
    this.joinedServer = true;
    this.reach = reach;
    this.persistNow();
    this.rebaselining?.delete('structure');
    if (this.rebaselining?.size === 0) this.rebaselining = null;
    this.ready = this.rebaselining == null;
    this.noteConfirmed();
    this.emitProjection('structure');
    this.flush();
    this.phase = this.rebaselining ? 'syncing' : 'live';
    this.backoffMs = 500;
    this.noteDrained();
    this.emitStatus();
  }

  // A sequenced frame is taken only as the next seq: an older one was seen already, and a later one is a gap that a fresh
  // graft heals.
  takesNextSeq(frame) {
    if (this.rebaselining?.has('structure') || this.discardPending) return false;
    if (typeof frame.seq !== 'number' || frame.seq <= this.lastSeq) return false;
    if (frame.seq > this.lastSeq + 1) { this.forceReconnect(); return false; }
    return true;
  }

  // A live broadcast: dense-seq gated, and never touches coverage.
  receiveLive(frame) {
    if (!this.takesNextSeq(frame)) return;
    const pointed = this.pointedIn(frame);
    let frontier;
    try {
      frontier = this.lattice.join(frame);
      if (!this.sent.has(frame.frameId)) {
        this.confirmedStructure.join(frame);
        this.confirm('structure');
      }
    } catch (error) {
      this.reportOnce('roadmap-sync-frame', error);
      this.forceReconnect();
      return;
    }
    for (const [actor, m] of frontier.marks) this.clock.observe({ ms: m.ms, counter: m.counter, actor });
    this.lastSeq = frame.seq;  // advance only after a successful join
    const mine = frame.frameId && this.sent.has(frame.frameId);
    this.scheduleSave();
    if (!mine) this.noteConfirmed();
    if (!mine) this.emitProjection('structure');
    this.releaseMarks(pointed);
    this.emitStatus();
  }

  // A subtree created under one of this tree's steps takes the next seq of the tree's stream, and changes nothing else here.
  receiveSubtree(frame) {
    if (!this.takesNextSeq(frame)) return;
    this.lastSeq = frame.seq;
    this.scheduleSave();
  }

  // The steps a frame names that open a tree before it joins.
  pointedIn(frame) {
    return (frame.nodes ?? []).filter((node) => this.lattice.nodes.get(node.id)?.opens.v);
  }

  // A pointer a join took away releases the mark set aside on its step, and it goes like any other.
  releaseMarks(pointed) {
    if (pointed.some((node) => this.markOwed(node.id)) && this.canResend('progress')) this.flushProgress();
  }

  receiveAck(frame) {
    const writes = this.inFlight.get(frame.frameId);
    if (!writes) return;
    this.settleUnanswered('structure', frame.frameId);
    this.ackedServerVector.join(frameFrontier(writes));
    this.confirmedStructure.join(writes);
    this.confirm('structure');
    this.inFlight.delete(frame.frameId);
    this.sent.delete(frame.frameId);
    if (stampsOf(writes)[0] === this.dropped.stamp) this.dropped = { stamp: null, closes: 0 };
    this.persistNow();
    this.noteConfirmed();
    this.noteDrained();
    this.emitStatus();
  }

  // Fires when the live session has no unconfirmed registers and no frames in flight.
  noteDrained() {
    const pending = {};
    for (const lane of ['structure', 'progress']) {
      if (!this.refusals.has(lane)) continue;
      pending[lane] = pendingRecordCount(this.unconfirmedWrites(lane));
      if (pending[lane] === 0) this.refusals.delete(lane);
    }
    if (this.phase !== 'live') return;
    for (const lane of ['structure', 'progress']) {
      if (this.inFlightOf(lane).size) continue;
      if (pending[lane] === undefined) {
        const checkingResend = this.resendBackoffMs[lane] !== FIRST_RESEND_MS
          && this.resendTimers[lane] === null && this.skewTimers[lane] === null;
        if (!this.drainedHandler && !checkingResend) continue;
        pending[lane] = pendingRecordCount(this.unconfirmedWrites(lane));
      }
      if (pending[lane] !== 0) continue;
      this.timers.clearTimeout(this.resendTimers[lane]);
      this.resendTimers[lane] = null;
      this.resendBackoffMs[lane] = FIRST_RESEND_MS;
    }
    if (!this.drainedHandler || this.inFlight.size || this.progressInFlight.size) return;
    if (pending.structure || pending.progress) return;
    this.drainedHandler();
  }

  // The complete progress graft replaces its confirmed baseline, exposing any marks the server lost.
  receiveProgressGraft(frame) {
    let frontier;
    try {
      frontier = this.progress.join(frame, this.reportInvalidProgressMark);
      this.confirmedProgress = new ProgressLattice();
      this.confirmedProgress.join(frame);
      this.gestures.progress = pendingGestures(this.progress.toFrame(), this.confirmedProgress.toFrame(), retainedGestures('progress', this.progress.toFrame(), this.gestures.progress));
    } catch (error) {
      this.reportOnce('roadmap-sync-frame', error);
      this.forceReconnect();
      return;
    }
    for (const [actor, m] of frontier.marks) this.clock.observe({ ms: m.ms, counter: m.counter, actor });
    this.confirmedKnown.progress = true;
    this.rebaselining?.delete('progress');
    if (this.rebaselining?.size === 0) {
      this.rebaselining = null;
      this.phase = 'live';
      this.ready = true;
    }
    this.persistNow();
    this.emitProjection('progress');
    this.flushProgress();
    this.noteDrained();
    this.emitStatus();
  }

  // Progress echoes follow server persistence, so even our own echo confirms its marks.
  receiveProgress(frame) {
    if (this.rebaselining?.has('progress') || this.discardPending) return;
    let frontier;
    try {
      frontier = this.progress.join(frame, this.reportInvalidProgressMark);
      this.confirmedProgress.join(frame);
      this.confirm('progress');
    } catch (error) {
      this.reportOnce('roadmap-sync-frame', error);
      this.forceReconnect();
      return;
    }
    for (const [actor, m] of frontier.marks) this.clock.observe({ ms: m.ms, counter: m.counter, actor });
    this.persistNow();
    this.emitProjection('progress');
    this.emitStatus();
  }

  receiveProgressAck(frame) {
    const writes = this.progressInFlight.get(frame.frameId);
    if (!writes) return;
    this.settleUnanswered('progress', frame.frameId);
    this.confirmedProgress.join(writes);
    this.confirm('progress');
    this.progressInFlight.delete(frame.frameId);
    this.persistNow();
    this.noteDrained();
    this.emitStatus();
  }

  // Queue the local snapshot before sending; a mark stays pending until an ack, durable echo or graft confirms it. A
  // caller that saves the write itself passes `save: false`.
  markProgress(nodeIds, status, { save = true } = {}) {
    if (this.rebaselining?.has('progress')) return this.progress.overlay();
    const now = Date.now();
    const at = this.clock.tick(now);
    const targets = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
    let changed = false;
    for (const nodeId of targets) {
      if (this.progress.mark(nodeId, status, at, now)) changed = true;
    }
    if (!changed) return this.progress.overlay();
    this.gestures.progress = pendingGestures(this.progress.toFrame(), this.confirmedProgress.toFrame(), this.gestures.progress);
    if (save) this.persistWrite();
    this.flushProgress();
    this.emitStatus();
    return this.progress.overlay();
  }

  // What a device copy's room showed done from its steps' seeds, where its lane holds no mark, made the person's own marks,
  // stamped as any mark made here, so a claim sends what the device showed.
  adoptSeeds() {
    if (this.progress.marks.size > 0) return;
    const seeded = this.lattice.toTreeData().nodes.filter((step) => step.status === 'complete').map((step) => step.id);
    if (seeded.length > 0) this.markProgress(seeded, 'complete');
  }

  flushProgress() {
    if (this.rebaselining?.has('progress') || this.discardPending) return;
    if (this.phase !== 'live' || this.ws?.readyState !== WebSocket.OPEN) return;
    const { frame, confirmed } = this.owedFrames('progress');
    const queued = outboxWrites(frame, confirmed, this.progressInFlight.values());
    if (!queued.marks.length) return;
    this.sendWithEpoch('progress', (socket) => {
      const pending = outboxWrites(queued, this.confirmedProgress.toFrame(), this.progressInFlight.values());
      if (!pending.marks.length) return;
      const writes = { marks: pending.marks.map(({ node, status, at }) => ({ node, status, at })) };
      const frameId = crypto.randomUUID?.() ?? `p-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      this.sendFrame('progress', socket, { t: 'progress', treeId: this.treeId, frameId, marks: writes.marks }, writes);
    });
  }

  inFlightOf(lane) {
    return lane === 'structure' ? this.inFlight : this.progressInFlight;
  }

  flushLane(lane) {
    if (lane === 'structure') return this.flush();
    return this.flushProgress();
  }

  settleUnanswered(lane, frameId, inclusive = false) {
    const inFlight = this.inFlightOf(lane);
    if (!inFlight.has(frameId)) return;
    let dropped = false;
    for (const earlierId of inFlight.keys()) {
      if (earlierId === frameId && !inclusive) break;
      inFlight.delete(earlierId);
      dropped = true;
      if (earlierId === frameId) break;
    }
    if (!dropped) return;
    this.reportOnce('roadmap-sync-dropped', new Error('Roadmap frame unanswered'), { lane });
    if (this.resendTimers[lane] !== null || !this.canResend(lane)) return;
    const delay = this.resendBackoffMs[lane];
    this.resendBackoffMs[lane] = Math.min(delay * 2, MAX_BACKOFF_MS);
    this.resendTimers[lane] = this.timers.setTimeout(() => {
      this.resendTimers[lane] = null;
      if (!this.canResend(lane)) return;
      this.flushLane(lane);
      this.noteDrained();
    }, delay);
  }

  canResend(lane) {
    return !this.closed && !this.discardPending && this.phase === 'live'
      && !this.rebaselining?.has(lane) && !this.refusals.has(lane) && this.skewTimers[lane] === null;
  }

  clearDeliveryTimers() {
    this.pingBoundaries = [];
    for (const lane of ['structure', 'progress']) {
      this.timers.clearTimeout(this.resendTimers[lane]);
      this.timers.clearTimeout(this.skewTimers[lane]);
      this.resendTimers[lane] = null;
      this.skewTimers[lane] = null;
    }
  }

  receiveSkew(frame) {
    const lane = this.inFlight.has(frame.frameId) ? 'structure'
      : this.progressInFlight.has(frame.frameId) ? 'progress' : null;
    if (!lane) return;
    this.clock.observe({ ms: frame.serverNow ?? 0, counter: 0, actor: 'srv' });
    this.settleUnanswered(lane, frame.frameId);
    const inFlight = this.inFlightOf(lane);
    inFlight.delete(frame.frameId);
    this.sent.delete(frame.frameId);
    this.emitStatus();
    this.durabilityAtRisk = true;
    const { frame: current, confirmed } = this.owedFrames(lane);
    const pending = outboxWrites(current, confirmed, inFlight.values());
    const frontier = lane === 'structure' ? frameFrontier(pending) : new ProgressLattice().join(pending);
    let maxMs = 0;
    for (const mark of frontier.marks.values()) maxMs = Math.max(maxMs, mark.ms);
    const deficit = Math.min(MAX_TIMER_MS, Math.max(FIRST_RESEND_MS, maxMs - (frame.serverNow ?? 0) + FIRST_RESEND_MS));
    this.timers.clearTimeout(this.skewTimers[lane]);
    this.skewTimers[lane] = this.timers.setTimeout(() => {
      this.skewTimers[lane] = null;
      if (!this.canResend(lane)) return;
      this.flushLane(lane);
      this.noteDrained();
    }, deficit);
  }

  receiveReject(frame) {
    const lane = this.inFlight.has(frame.frameId) ? 'structure'
      : this.progressInFlight.has(frame.frameId) ? 'progress' : null;
    // The server stops taking this connection for a writer without a word: refusing its writes is how it says so.
    if (isSessionRefusal(frame) || frame.code === 'no-such-tree') this.reach = 'reader';
    if (strandsTheBank(frame) && lane && !isOwnershipRefusal(frame) && !isSessionRefusal(frame)) {
      const refusal = this.standRefusal(lane, frame.code);
      for (const handler of this.refusalHandlers) handler(refusal);
    }
    if (lane) {
      this.settleUnanswered(lane, frame.frameId);
      const inFlight = this.inFlightOf(lane);
      inFlight.delete(frame.frameId);
      this.sent.delete(frame.frameId);
    }
    this.emitStatus();
    // A refused subgraph frame strands the edits banked behind it, whatever its code.
    if (strandsTheBank(frame)) this.durabilityAtRisk = true;
    if (!strandsTheBank(frame) && !isOwnershipRefusal(frame) && !isSessionRefusal(frame)) {
      console.warn('[sync] frame rejected —', frame.code, frame.reason);
      return;
    }
    window.dispatchEvent(new CustomEvent('wm-edit-forbidden', { detail: frame }));
  }

  // The lane's refused card: the same bank keeps its episode across re-flushes.
  standRefusal(lane, code) {
    const signature = JSON.stringify(Object.entries(this.unconfirmedWrites(lane)).sort());
    const previous = this.refusalEpisodes.get(lane);
    const episode = previous?.signature === signature ? previous.episode : Object.freeze({});
    this.refusalEpisodes.set(lane, { signature, episode });
    const refusal = Object.freeze({ lane, code, episode });
    this.refusals.set(lane, refusal);
    return refusal;
  }

  confirm(lane) {
    const confirmed = lane === 'structure' ? this.confirmedStructure.toFrame() : this.confirmedProgress.toFrame();
    this.gestures[lane] = pendingGestures({}, confirmed, this.gestures[lane]);
  }

  emitProjection(lane) {
    try {
      if (lane === 'structure') {
        this.emitTree();
        return;
      }
      const progress = this.discardPending && this.rebaselining?.has('progress') ? this.confirmedProgress : this.progress;
      this.progressHandler?.(progress.overlay());
    } catch (error) {
      this.reportFailure('roadmap-sync-notify', error);
    }
  }

  // A discard shows the confirmed lane at once, ahead of the replaced record; from then on the lattice is what stands.
  emitTree() {
    const lattice = this.discardPending && this.rebaselining?.has('structure') ? this.confirmedStructure : this.lattice;
    this.treeHandler?.(lattice.toTreeData());
  }

  // How many of this person's acts the server does not hold: one Delete is one, however many records it wrote.
  pendingEditCount() {
    return Object.keys(this.gestures.structure).length;
  }

  pendingStructureCount() {
    return pendingRecordCount(this.unconfirmedWrites('structure'));
  }

  pendingProgressCount() {
    return pendingRecordCount(this.unconfirmedWrites('progress'));
  }

  // The structure writes the server does not hold and this connection does not carry, less the stamps held as
  // unsendable.
  unsentStructure() {
    const pending = outboxWrites(this.lattice.toFrame(), this.confirmedStructure.toFrame(), this.inFlight.values());
    if (!this.unsendable.size) return pending;
    return { nodes: [], edges: [], kinds: [], ...frameWrites(pending, (key, stamp) => !this.unsendable.has(stamp)) };
  }

  // Sends what the lane has unsent, as frames of whole stamps in stamp order (framesOf), each write under the stamp
  // it was made with: a reload in the middle of a send resends the same frames.
  flush() {
    if (this.rebaselining?.has('structure') || this.discardPending) return;
    const pending = this.unsentStructure();
    if (writesNothing(pending)) return;
    this.send(pending, 'flush');
  }

  dispatch(gesture) {
    if (!this.ready) return null;
    const writes = materialize(gesture, this.lattice, this.clock);
    if (!writes.nodes.length && !writes.edges.length && !writes.kinds.length) return null;
    const inverse = this.captureInverse(writes);
    const receipt = Object.freeze({});
    const redo = this.redoStack;
    this.undoStack.push(inverse);
    this.redoStack = [];
    let written;
    try {
      written = this.apply(writes);
    } catch (error) {
      this.undoStack.splice(this.undoStack.indexOf(inverse), 1);
      this.redoStack = redo;
      throw error;
    }
    this.receipts.set(receipt, { inverse, written: writeStamps(written) });
    return receipt;
  }

  // Takes back what the receipt wrote and leaves alone any register written since, by this person or a peer.
  revert(receipt) {
    if (!this.ready) return false;
    const held = this.receipts.get(receipt);
    if (!held) return false;
    const index = this.undoStack.indexOf(held.inverse);
    if (index === -1) return false;
    const writes = this.restamp(this.stillStanding(held), this.clock.tick(Date.now()));
    if (Object.keys(writeStamps(writes)).length) this.apply(writes);
    this.receipts.delete(receipt);
    this.undoStack.splice(index, 1);
    this.redoStack = [];
    return true;
  }

  // A receipt's inverse without the registers something later has overwritten.
  stillStanding({ inverse, written }) {
    const current = writeStamps(this.lattice.toFrame());
    const standing = (section, id, field) => {
      const key = JSON.stringify([section, id, field]);
      return current[key] === written[key];
    };
    const fields = (section, row) => Object.fromEntries(Object.entries(row).filter(([field]) => {
      if (field === 'id') return true;
      if (field === 'deleteLife') return standing(section, row.id, 'createdAt');
      if (field === 'addLife') return standing(section, row.id, 'deletedAt');
      return standing(section, row.id, `${field}At`);
    }));
    return {
      nodes: inverse.nodes.map((row) => fields('nodes', row)),
      edges: inverse.edges.filter((row) => standing('edges', [row.from, row.to], row.add ? 'removedAt' : 'addedAt')),
      kinds: inverse.kinds.map((row) => fields('kinds', row)),
    };
  }

  // A held delete is the last act though nothing is written yet: the next Undo takes it back. Its record is read now, as leaving leaves no time to.
  holdAct(cancel) {
    this.heldAct = cancel;
    this.store.load?.(this.treeId).catch(() => {});
  }

  endHeldAct() {
    this.heldAct = null;
  }

  // One stamped write to the title register, LWW against concurrent renames and out of the undo
  // journal. Returns false before the durable lattice loads, when the caller must PATCH instead.
  renameTree(title) {
    if (!this.ready) return false;
    const next = title.trim();
    if (!next || next === this.lattice.title) return true;
    this.writeRegister('title', next);
    return true;
  }

  // The guide's one stamped write, as a rename is: last writer wins, nothing enters the undo journal, and an empty guide
  // is none. Returns false before the durable lattice loads, when the caller must take another door. Text the server
  // would refuse never enters the lattice, where its refusal would stand over the lane until a Discard.
  setGuide(guide) {
    if (!admitsGuide(guide)) throw new InadmissibleGuide();
    if (!this.ready) return false;
    if (guide !== this.lattice.guide) this.writeRegister('guide', guide);
    return true;
  }

  writeRegister(name, value) {
    const at = this.clock.tick(Date.now());
    this.apply({ nodes: [], edges: [], kinds: [], [name]: { v: value, at: hlcText(at) } });
  }

  undo() {
    if (this.heldAct) {
      this.heldAct();
      return;
    }
    this.replay(this.undoStack, this.redoStack);
  }

  redo() { this.replay(this.redoStack, this.undoStack); }

  replay(from, to) {
    if (this.rebaselining) return;
    const inverse = from.at(-1);
    if (!inverse) return;
    const writes = this.restamp(inverse, this.clock.tick(Date.now()));
    const counterInverse = this.captureInverse(writes);
    this.receiptVersion += 1;
    this.apply(writes);
    from.pop();
    to.push(counterInverse);
  }

  // Steps a removal elsewhere takes (`PruneNodes`), with the person's marks on them cleared: a local write outside the
  // undo journal, sent as any other and saved once. Answers what failed of the save, which the caller reports.
  async removeSteps(stepIds) {
    const writes = materialize({ kind: 'PruneNodes', nodeIds: stepIds }, this.lattice, this.clock);
    if (writes.nodes.length === 0) return null;
    const marked = stepIds.filter((id) => this.progress.marks.get(id)?.status === 'complete');
    this.apply(writes, { save: false });
    if (marked.length > 0) this.markProgress(marked, 'none', { save: false });
    let failure = null;
    await this.persistNow((error) => { failure = error ?? new DOMException('The steps were not saved', 'AbortError'); });
    return failure;
  }

  // Every step that opens the tree `from` opens `to` instead (`Repoint`), as when a claim gives that tree a fresh id: a local
  // write outside the undo journal, sent as any other. Answers whether a step opened it.
  repoint(from, to) {
    const writes = materialize({ kind: 'Repoint', from, to }, this.lattice, this.clock);
    if (writes.nodes.length === 0) return false;
    this.apply(writes);
    return true;
  }

  // A local write: stamped for the frames that will carry it (stampedPerFrame), joined, shown, saved unless the caller
  // saves it (`save: false`), and sent while live. Every local write comes through here, so the stamps the lattice and
  // the saved record hold are the ones its frames go out under. Answers the write as it was stamped. One act stays one
  // unsent edit however many stamps it was cut into: it is counted under its first.
  apply(writes, { save = true } = {}) {
    writes = stampedPerFrame(writes, this.clock, this.room);
    const pointed = this.pointedIn(writes);
    this.lattice.join(writes);
    const act = stampsOf(writes)[0];
    this.gestures.structure = pendingGestures({}, this.confirmedStructure.toFrame(),
      act ? { ...this.gestures.structure, [act]: writeStamps(writes) } : this.gestures.structure);
    try {
      this.emitStatus();
    } catch (error) {
      this.reportFailure('roadmap-sync-notify', error);
    }
    try {
      this.emitTree();
    } catch (error) {
      this.reportFailure('roadmap-sync-notify', error);
    }
    if (save) this.persistWrite();
    if (this.phase !== 'live') return writes;
    try {
      this.send(writes);
    } catch (error) {
      this.durabilityAtRisk = true;
      this.reportFailure('roadmap-sync-send', error);
      this.forceReconnect();
    }
    this.releaseMarks(pointed);
    return writes;
  }

  // A local write's save: a failure leaves the write standing and durability at risk.
  persistWrite() {
    try {
      this.persistNow((error) => this.reportFailure('roadmap-sync-persist', error));
    } catch (error) {
      this.durabilityAtRisk = true;
      this.reportFailure('roadmap-sync-persist', error);
    }
  }

  send(writes, intent = 'live') {
    if (this.rebaselining?.has('structure') || this.discardPending) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.sendWithEpoch('structure', (socket) => {
      if (intent === 'flush') writes = outboxWrites(writes, this.confirmedStructure.toFrame(), this.inFlight.values());
      // A pointer goes only to a server that takes this connection for a writer; until one does it stays owed here.
      if (!this.writesPointers) writes = frameWrites(writes, (key) => JSON.parse(key)[2] !== 'opensAt');
      if (writesNothing(writes)) return;
      // A write goes as one frame, or as many as its stamps take: each frame whole stamps, earliest first (framesOf).
      for (const part of framesOf(writes, this.room)) {
        const frameId = crypto.randomUUID?.() ?? `f-${Date.now()}-${Math.random()}`;
        this.sent.add(frameId);
        this.sendFrame('structure', socket, { t: 'subgraph', v: 1, treeId: this.treeId, frameId, actor: this.actor, intent, ...part },
          structuredClone(part));
      }
    });
  }

  sendFrame(lane, socket, frame, writes) {
    const inFlight = this.inFlightOf(lane);
    inFlight.set(frame.frameId, writes);
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      inFlight.delete(frame.frameId);
      this.durabilityAtRisk = true;
      this.reportFailure('roadmap-sync-send', error);
      this.forceReconnect();
    }
    this.emitStatus();
  }

  // A closed session's send still goes, as its socket waits for it; a send the page is leaving behind goes at once, without the epoch's read.
  sendWithEpoch(lane, send) {
    const socket = this.ws;
    const epoch = this.epochs[lane];
    const checkedSend = () => {
      if (this.discardPending || this.rebaselining?.has(lane) || this.epochs[lane] !== epoch) return;
      if (socket?.readyState !== WebSocket.OPEN || (socket !== this.ws && !this.closed)) return;
      send(socket);
    };
    if (this.leaving || !this.store.withEpoch) return checkedSend();
    const sending = this.store.withEpoch(this.treeId, lane, epoch, checkedSend).then((result) => {
      if (result.status === 'stale') this.adoptEpochs(result.value);
    }).catch((error) => {
      this.durabilityAtRisk = true;
      this.reportFailure('roadmap-sync-send', error);
      this.standRefusal(lane, UNSENDABLE);
      this.emitStatus();
    }).finally(() => this.sending.delete(sending));
    this.sending.add(sending);
    return sending;
  }

  // The page is going with a write still to make, so writes save and send synchronously; only a hold asks, as a blind save can overwrite another tab's.
  leavePage() {
    this.leaving = true;
  }

  // Persists both lanes + lastSeq atomically; the snapshot is taken synchronously, before any
  // await. A closed session never writes. Returns the save's settle.
  persistNow(onFailure = null) {
    if (this.closed) return Promise.resolve();
    if (this.discardPending) {
      this.deferredSave = true;
      return Promise.resolve();
    }
    this.timers.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const value = {
      frame: this.lattice.toFrame(), progress: this.progress.toFrame(), lastSeq: this.lastSeq,
      epochs: { ...this.epochs },
      gestures: structuredClone(this.gestures),
      confirmed: {
        structure: this.confirmedKnown.structure ? this.confirmedStructure.toFrame() : null,
        progress: this.confirmedKnown.progress ? this.confirmedProgress.toFrame() : null,
      },
    };
    this.registry?.touch(this.treeId, this.lattice.title);
    const saving = this.leaving ? this.store.saveWhileLeaving(this.treeId, value) : this.store.save(this.treeId, value);
    return saving.then((result) => {
      if (result?.status === 'stale') this.adoptEpochs(result.value);
      return result;
    }, (error) => {
      this.durabilityAtRisk = true;
      onFailure?.(error);
    });
  }

  persistDeferred() {
    if (!this.deferredSave) return Promise.resolve();
    this.deferredSave = false;
    return this.persistNow((error) => this.reportFailure('roadmap-sync-persist', error));
  }

  // Coalesced receive-path save retains the lattice and its separately confirmed baseline.
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = this.timers.setTimeout(() => { this.saveTimer = null; this.persistNow(); }, 250);
  }

  captureInverse(writes) {
    const nodes = (writes.nodes ?? []).map((n) => {
      const record = this.lattice.nodes.get(n.id);
      const inv = { id: n.id };
      if (n.createdAt) inv.deleteLife = true;   // undo a create → tombstone
      if (n.deletedAt) inv.addLife = true;      // undo a delete → re-add; fields survive in the lattice
      for (const name of NODE_REGISTERS) if (`${name}At` in n) inv[name] = record ? record[name].v : UNWRITTEN_NODE[name];
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
      for (const name of NODE_REGISTERS) if (name in n) { e[name] = n[name]; e[`${name}At`] = s; }
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
    this.presenceTimer = this.timers.setTimeout(() => {
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
    this.clearDeliveryTimers();
    this.unsubscribeEpochs?.();
    this.unsubscribeEpochs = null;
    if (typeof window !== 'undefined') {
      if (this.pagehide) window.removeEventListener('pagehide', this.pagehide);
      if (this.pageshow) window.removeEventListener('pageshow', this.pageshow);
      if (this.onVisible) document.removeEventListener('visibilitychange', this.onVisible);
      if (this.onOnline) window.removeEventListener('online', this.onOnline);
      if (this.onOffline) window.removeEventListener('offline', this.onOffline);
    }
    this.pagehide = this.pageshow = this.onVisible = this.onOnline = this.onOffline = null;
    this.stopHeartbeat();
    this.timers.clearTimeout(this.presenceTimer);
    this.timers.clearTimeout(this.reconnectTimer);
    this.timers.clearTimeout(this.saveTimer);
    this.presenceTimer = this.reconnectTimer = this.saveTimer = null;
    const socket = this.ws;
    this.ws = null;
    if (this.sending.size) Promise.allSettled([...this.sending]).then(() => socket?.close());
    else socket?.close();
    this.phase = 'offline';
    this.inFlight.clear();
    this.progressInFlight.clear();
    this.sent.clear();
    this.emitStatus();
    this.statusHandlers.clear();
    this.refusalHandlers.clear();
  }
}
