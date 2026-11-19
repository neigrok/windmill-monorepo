// The room's reading of a roadmap from the device's copy, behind the switch the route table reads (roadmap-on-the-engine.md
// §5, §8.4). As the room opens it subscribes the roadmap's tree scope, and with it the account's overlay of it (E-3); a
// roadmap someone else owns is read with each roadmap above it, each subscribed the same way. It observes the account's
// list (`self/roadmap`) and every scope the domain reads the roadmap through, opens from what the device holds without
// waiting on the network, follows each change, and drops every scope it subscribed when the room leaves. On the
// person's own roadmap it is the room's write door too: the domain's actions on the kit's runner, through the room's
// session (`ReplicaSession`); and it reads, and clears once said, what the device tells of the person's own changes
// that met another device's (§6).

import { Fields } from '../../../platform/domain-kit/entities.js';
import { ActionRunner, EngineReplica } from '../../../platform/domain-kit/runner.js';
import { syncSession } from '../../../platform/sync/session.js';
import { ClearLanding, landingOf } from '../domain/landing.js';
import { Roadmap, RoadmapMeta } from '../domain/roadmaps.js';
import { RoadmapScopes } from '../domain/roadmapRules.js';
import { HttpTreeRepository } from '../persistence/HttpTreeRepository.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { HeldRoadmap, ReplicaRoadmap } from './ReplicaRoadmap.js';
import { ReplicaSession } from './ReplicaSession.js';

// How long a room that holds no copy of its roadmap waits on the engine and the server's first answer before it says
// it could not load the roadmap.
export const FIRST_COPY_MS = 10_000;

const same = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);

// The person's own zone, as the device keeps it, for the moments the domain's actions read.
const DEVICE_ZONE = { offsetSeconds: (instant) => -new Date(instant.ms).getTimezoneOffset() * 60 };

export class ReplicaReading {
  // `room` holds the handles the room's writes reach for; `say` shows the room's toast. A reading of no roadmap
  // (`treeId` null) reads the person's roadmaps alone, and asks the server nothing.
  constructor({ treeId, room = null, say = () => {}, session = syncSession, timers = globalThis, report = reportRoadmapFailure,
    repository = treeId === null ? null : new HttpTreeRepository({ treeId }) }) {
    this.treeId = treeId;
    this.scope = treeId === null ? null : RoadmapScopes.tree(treeId);
    this.room = room;
    this.say = say;
    this.session = session;
    this.timers = timers;
    this.report = report;
    this.repository = repository;
    // The room's status line reads this reading as it reads roadmap's own session; `ready` says a write can be taken.
    this.ready = false;
    this.writes = null;
    this.engine = null;
    this.subscribed = new Set();
    this.holds = new Map();
    this.listeners = new Set([() => this.emitStatus()]);
    this.statusHandlers = new Set();
    this.told = null;
    // The name of each step of the open roadmap the visit has read, so a line can name one deleted since.
    this.named = new Map();
    this.landingFailed = false;
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
    this.openWrites(roadmap.mine);
    const seed = roadmap.seed;
    const overlay = roadmap.mine ? roadmap.marks : await this.repository.loadProgress(seed, { signal: AbortSignal.timeout(FIRST_COPY_MS) });
    return { seed, overlay, workspace: roadmap.mine ? roadmap.workspace : null, guides: roadmap.guides };
  }

  // Each change the replica draws after the room opened, handed on in the room's shapes; what the device tells of the
  // person's own changes as it opens and after each change; the server's tail of the roadmap's activity once it answers.
  follow({ onTree, onProgress, onWorkspace, onGuides, onLanding, onActivity }) {
    if (this.ready && this.room) this.room.sessionRef.current = this.writes;
    let shown = this.opened;
    onLanding(this.landing());
    this.listeners.add(() => {
      const roadmap = this.roadmap();
      if (roadmap === shown || roadmap.state !== 'open') return;
      shown = roadmap;
      onTree(roadmap.seed);
      if (roadmap.mine) {
        onProgress(roadmap.marks);
        onWorkspace(roadmap.workspace);
        onLanding(this.landing());
      }
      onGuides(roadmap.guides);
    });
    this.repository.loadActivity({ limit: 200, signal: this.stopped.signal })
      .then((events) => { if (!this.closed && events.length) onActivity(events); });
  }

  // §6 What the device tells its owner once of their own changes on this roadmap, a line a step (`ReplicaRoadmap.landed`);
  // nothing on a roadmap someone else owns. A read that fails tells nothing and reports once, and the room reads on.
  landing() {
    if (!this.ready) return [];
    try {
      const roadmap = this.roadmap();
      for (const step of roadmap.account.trees.get(this.treeId).nodes) this.named.set(step.id, step.label);
      return roadmap.landed(this.writes.runner.read(this.scope, (read) => landingOf(this.treeId, read)), this.named);
    } catch (error) {
      if (!this.landingFailed) this.report('roadmap-replica-landing', error);
      this.landingFailed = true;
      return [];
    }
  }

  // The person was shown these lines: the device clears what they said from its note, out of the Undo stack.
  tell(lines) {
    const told = (part) => lines.flatMap((line) => line.told[part] ?? []);
    return this.writes.settle([new ClearLanding(this.treeId, { nodes: told('nodes'), edges: told('edges'), revived: told('revived') })], 'landing');
  }

  // The person's roadmaps alone, for a page that lists them (a reading of no roadmap, `treeId` null): once the engine
  // stands, the list as the replica holds it now and after each change, and the write door. False where the engine did
  // not stand within the bound.
  async readRoadmaps({ signal, onList }) {
    this.engine = await this.engineWithin(signal);
    if (!this.engine || signal.aborted) return false;
    this.unwatch = this.engine.observeEngine(this.changed);
    this.openWrites(false);
    this.listeners.add(() => onList(this.list()));
    onList(this.list());
    return true;
  }

  // The account's roadmaps as the switcher lists them, where the replica keeps them.
  list() {
    return this.roadmap().list(this.engine.getSnapshot().state === 'bound' ? 'account' : 'device');
  }

  // An address of one of the person's roadmaps, as the tree picker reads one: null where the replica keeps no such roadmap
  // of theirs.
  card(id) {
    const row = this.list().find((each) => each.id === id);
    return row ? { id, title: row.title, author: null, steps: row.total ?? null, mine: true } : null;
  }

  // The write door: the kit's runner over the engine, and the room's session over it, which takes the room's writes on
  // the open roadmap where it is the person's own (`mine`) and their roadmaps' names from any room.
  openWrites(mine) {
    const runner = new ActionRunner(new EngineReplica(this.engine), this.engine.registry, DEVICE_ZONE);
    this.writes = new ReplicaSession({ treeId: this.treeId, runner, roadmap: () => this.roadmap(), say: this.say, onStatus: () => this.emitStatus() });
    this.ready = mine;
  }

  close() {
    this.closed = true;
    this.ready = false;
    this.writes?.close();
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
  // roadmap in it or a reading of no roadmap, every roadmap of the account; for any other, the roadmap and each roadmap
  // above it. Unchanged records answer the reading they answered before.
  roadmap() {
    const list = this.observe(RoadmapScopes.account);
    const listed = new Map(list.drawn.filter((record) => record.t === Roadmap.type).map((record) => [String(record.id), record]));
    const ids = this.treeId === null || listed.has(this.treeId) ? [...listed.keys()] : this.lineage();
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
      this.subscribeTo(scope);
      const meta = this.observe(scope).drawn.find((record) => record.t === RoadmapMeta.type);
      id = meta ? RoadmapMeta.decode(Fields.record(meta)).parent?.tree ?? null : null;
    }
    return ids;
  }

  // A scope the reading comes to read, subscribed once, so the server's copy of it arrives.
  subscribeTo(scope) {
    if (this.subscribed.has(scope)) return;
    this.subscribed.add(scope);
    this.engine.subscribe(scope).catch(() => {});
  }

  // What the replica holds of one roadmap, its tree scope subscribed, the same holding while its records are the same.
  holding(id, record) {
    this.subscribeTo(RoadmapScopes.tree(id));
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
      structureGestures: 0, progressGestures: 0, rebaselining: false, progressBlocked: false, refused: null, receiptVersion: this.writes?.receiptVersion ?? 0,
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
