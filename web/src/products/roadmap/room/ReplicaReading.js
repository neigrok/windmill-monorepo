// The room's reading of a roadmap from the device's copy, behind the switch the route table reads (roadmap-on-the-engine.md
// §5, §8.4). As the room opens it subscribes the roadmap's tree scope, and with it the account's overlay of it (E-3); a
// roadmap someone else owns is read with each roadmap above it, each subscribed the same way. It observes the account's
// list (`self/roadmap`) and every scope the domain reads the roadmap through, opens from what the device holds without
// waiting on the network, follows each change, and drops every scope it subscribed when the room leaves. It takes no
// write: the room's gestures reach the replica through the domain's actions in the next build.

import { Fields } from '../../../platform/domain-kit/entities.js';
import { syncSession } from '../../../platform/sync/session.js';
import { Roadmap, RoadmapMeta } from '../domain/roadmaps.js';
import { RoadmapScopes } from '../domain/roadmapRules.js';
import { HttpTreeRepository } from '../persistence/HttpTreeRepository.js';
import { HeldRoadmap, ReplicaRoadmap } from './ReplicaRoadmap.js';

// How long a room that holds no copy of its roadmap waits on the engine and the server's first answer before it says
// it could not load the roadmap.
export const FIRST_COPY_MS = 10_000;

const same = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);

export class ReplicaReading {
  constructor({ treeId, session = syncSession, timers = globalThis, repository = new HttpTreeRepository({ treeId }) }) {
    this.treeId = treeId;
    this.scope = RoadmapScopes.tree(treeId);
    this.session = session;
    this.timers = timers;
    this.repository = repository;
    // The room's status line reads this reading as it reads roadmap's own session; `ready` says a write can be taken.
    this.ready = false;
    this.engine = null;
    this.subscribed = new Set();
    this.holds = new Map();
    this.listeners = new Set([() => this.emitStatus()]);
    this.statusHandlers = new Set();
    this.told = null;
    this.holdings = new Map();
    this.last = null;
    this.stopped = new AbortController();
    this.closed = false;
  }

  get status() { return this; }

  // The engine's replica says whose copies these are: nothing is asked of the network first.
  async settleHolder() {}

  // The roadmap as the device holds it once it can be shown: null where the person may read no such roadmap, or
  // where none came within the bound. A roadmap someone else owns shows its owner's marks, as the server reads them.
  async read({ signal }) {
    this.engine = await this.engineWithin(signal);
    if (!this.engine || signal.aborted) return null;
    this.unwatch = this.engine.observeEngine(this.changed);
    if (await this.engine.subscribe(this.scope) === 'gone') return null;
    this.subscribed.add(this.scope);
    const roadmap = await this.firstCopy(signal);
    if (roadmap?.state !== 'open' || signal.aborted) return null;
    this.opened = roadmap;
    const seed = roadmap.seed;
    const overlay = roadmap.mine ? roadmap.marks : await this.repository.loadProgress(seed, { signal: AbortSignal.timeout(FIRST_COPY_MS) });
    return { seed, overlay, workspace: roadmap.mine ? roadmap.workspace : null, guides: roadmap.guides };
  }

  // Each change the replica draws after the room opened, handed on in the room's shapes; the server's tail of the
  // roadmap's activity once it answers.
  follow({ onTree, onProgress, onWorkspace, onGuides, onActivity }) {
    let shown = this.opened;
    this.listeners.add(() => {
      const roadmap = this.roadmap();
      if (roadmap === shown || roadmap.state !== 'open') return;
      shown = roadmap;
      onTree(roadmap.seed);
      if (roadmap.mine) {
        onProgress(roadmap.marks);
        onWorkspace(roadmap.workspace);
      }
      onGuides(roadmap.guides);
    });
    this.repository.loadActivity({ limit: 200, signal: this.stopped.signal })
      .then((events) => { if (!this.closed && events.length) onActivity(events); });
  }

  // The account's roadmaps as the switcher lists them, where the replica keeps them.
  list() {
    return this.roadmap().list(this.engine.getSnapshot().state === 'bound' ? 'account' : 'device');
  }

  close() {
    this.closed = true;
    this.stopped.abort();
    this.unwatch?.();
    for (const { hold, stop } of this.holds.values()) {
      stop();
      hold.release();
    }
    this.listeners.clear();
    this.statusHandlers.clear();
    for (const scope of this.subscribed) this.engine?.unsubscribe(scope).catch(() => {});
  }

  // The engine the shell opens for this document, once it stands; null where it failed or did not within the bound.
  engineWithin(signal) {
    return new Promise((resolve) => {
      const check = () => {
        const { engine, ready, error } = this.session.getSnapshot();
        if (ready && engine) finish(engine);
        else if (error) finish(null);
      };
      const finish = (engine) => {
        stop();
        this.timers.clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve(engine);
      };
      const abort = () => finish(null);
      const timer = this.timers.setTimeout(abort, FIRST_COPY_MS);
      const stop = this.session.subscribe(check);
      signal.addEventListener('abort', abort, { once: true });
      check();
    });
  }

  // The roadmap once the device can say what it is: the copy it holds, or the server's first answer. Where the engine
  // cannot reach the server, once nothing is left to read from the device, it says what it holds; with no answer within
  // the bound, it stops waiting.
  firstCopy(signal) {
    return new Promise((resolve) => {
      let roadmap = null;
      const check = () => {
        roadmap = this.roadmap();
        const { connection, authPaused, upgradeRequired } = this.engine.getSnapshot();
        const cut = connection !== 'online' || authPaused || upgradeRequired;
        if (roadmap.state !== 'waiting' || (cut && [...this.holds.values()].every(({ hold }) => hold.getSnapshot().loaded))) finish();
      };
      const finish = () => {
        this.listeners.delete(check);
        this.timers.clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve(roadmap);
      };
      const timer = this.timers.setTimeout(finish, FIRST_COPY_MS);
      signal.addEventListener('abort', finish, { once: true });
      this.listeners.add(check);
      check();
    });
  }

  // Every hold, and the engine's own state, says a publication happened: the readings run once it has reached every
  // hold.
  changed = () => {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.closed) for (const listener of [...this.listeners]) listener();
    });
  };

  // The roadmap as the replica holds it now, observing every scope it is read through: the account's list and, for a
  // roadmap in it, every roadmap of the account; for any other, the roadmap and each roadmap above it. Unchanged
  // records answer the reading they answered before.
  roadmap() {
    const list = this.observe(RoadmapScopes.account);
    const listed = new Map(list.drawn.filter((record) => record.t === Roadmap.type).map((record) => [String(record.id), record]));
    const ids = listed.has(this.treeId) ? [...listed.keys()] : this.lineage();
    const held = ids.map((id) => this.holding(id, listed.get(id) ?? null));
    const listRead = list.firstPullComplete && list.loaded;
    if (this.last && this.last.listRead === listRead && same(this.last.held, held)) return this.last.roadmap;
    this.last = { listRead, held, roadmap: new ReplicaRoadmap(this.engine.registry, this.treeId, held, { listRead }) };
    return this.last.roadmap;
  }

  // The open roadmap and each roadmap above it, as their metas name them, each subscribed as the room comes to read it.
  lineage() {
    const ids = [];
    for (let id = this.treeId; id !== null && !ids.includes(id);) {
      ids.push(id);
      const scope = RoadmapScopes.tree(id);
      if (!this.subscribed.has(scope)) {
        this.subscribed.add(scope);
        this.engine.subscribe(scope).catch(() => {});
      }
      const meta = this.observe(scope).drawn.find((record) => record.t === RoadmapMeta.type);
      id = meta ? RoadmapMeta.decode(Fields.record(meta)).parent?.tree ?? null : null;
    }
    return ids;
  }

  // What the replica holds of one roadmap, the same holding while its records are the same.
  holding(id, record) {
    const tree = this.observe(RoadmapScopes.tree(id));
    const overlay = this.observe(RoadmapScopes.overlay(id));
    const read = tree.firstPullComplete && tree.loaded;
    const known = this.holdings.get(id);
    if (known && known.record === record && known.read === read && same(known.tree, tree.drawn) && same(known.overlay, overlay.drawn)
      && same(known.queued, overlay.pending)) return known.held;
    const held = new HeldRoadmap({ id, record, tree: tree.drawn, overlay: overlay.drawn, queued: overlay.pending, read });
    this.holdings.set(id, { record, read, tree: tree.drawn, overlay: overlay.drawn, queued: overlay.pending, held });
    return held;
  }

  // The scope's snapshot, through the one hold this reading keeps on it until it closes.
  observe(scope) {
    if (!this.holds.has(scope)) {
      const hold = this.engine.observe(scope);
      this.holds.set(scope, { hold, stop: hold.subscribe(this.changed) });
    }
    return this.holds.get(scope).hold.getSnapshot();
  }

  subscribeStatus(handler) {
    this.statusHandlers.add(handler);
    handler(this.statusSnapshot());
    return () => this.statusHandlers.delete(handler);
  }

  // What the room's status line reads, in the words of roadmap's own session: whether the browser reports a network and
  // whether the engine may reach the server, and the roadmap's changes the server has not taken, waiting or on their
  // way, its own and those a command predicts into it. Nothing here is refused, rebaselined or blocked: §6 lists what
  // cannot land in its one place.
  statusSnapshot() {
    const state = this.engine?.getSnapshot() ?? null;
    const outbox = (scope) => this.holds.get(scope)?.hold.getSnapshot().outbox ?? { ready: 0, sent: 0 };
    const tree = outbox(this.scope), overlay = outbox(RoadmapScopes.overlay(this.treeId));
    const snapshot = {
      phase: state?.connection === 'online' && !state.authPaused && !state.upgradeRequired ? 'live' : 'connecting',
      online: state === null ? this.session.getSnapshot().online : state.connection !== 'offline',
      structurePending: tree.ready, progressPending: overlay.ready, structureInFlight: tree.sent, progressInFlight: overlay.sent,
      structureGestures: 0, progressGestures: 0, rebaselining: false, progressBlocked: false, refused: null, receiptVersion: 0,
    };
    if (this.told && Object.keys(snapshot).every((key) => this.told[key] === snapshot[key])) return this.told;
    this.told = Object.freeze(snapshot);
    return this.told;
  }

  emitStatus() {
    const previous = this.told;
    const snapshot = this.statusSnapshot();
    if (snapshot === previous) return;
    for (const handler of this.statusHandlers) handler(snapshot);
  }
}
