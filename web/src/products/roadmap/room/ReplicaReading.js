// The room's reading of a roadmap from the device's copy, behind the switch the route table reads (roadmap-on-the-engine.md
// §5, §8.4). As the room opens it subscribes the roadmap's tree scope, and with it the account's overlay of it (E-3); a
// roadmap someone else owns is read with each roadmap above it, each subscribed the same way. It observes the account's
// list (`self/roadmap`) and every scope the domain reads the roadmap through, opens from what the device holds without
// waiting on the network, follows each change, and drops every scope it subscribed when the room leaves. On the
// person's own roadmap it is the room's write door too: the domain's actions on the kit's runner, through the room's
// session (`ReplicaSession`); and it reads, and clears once said, what the device tells of the person's own changes
// that met another device's (§6), and lets that note go whole when it finds the roadmap gone.

import { Fields } from '../../../platform/domain-kit/entities.js';
import { ActionRunner, EngineReplica } from '../../../platform/domain-kit/runner.js';
import { syncSession } from '../../../platform/sync/session.js';
import { track as beacon } from '../../../telemetry/beacon.js';
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
export const DEVICE_ZONE = { offsetSeconds: (instant) => -new Date(instant.ms).getTimezoneOffset() * 60 };

// Why a room's roadmap cannot be shown, as the room tells it once a visit (`roadmap_load`): the device's copy could not
// open, or did not open within the bound; the device, having its answer, holds no roadmap the person may read at the
// address; or no answer came.
export const UNSHOWN = Object.freeze(['unkept', 'unopened', 'missing', 'unanswered']);

// The engine the shell opens for this document, once it stands: `{ engine }`, or `{ unshown }` saying why there is none to
// read or write through: `unkept` where it could not open, as in a browser that keeps nothing (no replica held in memory
// stands in for one yet, E-5), and `unopened` where it did not stand within the bound or the caller stopped waiting.
export function standingEngine(session, signal, timers = globalThis) {
  return new Promise((resolve) => {
    const check = () => {
      const { engine, ready, error } = session.getSnapshot();
      if (ready && engine) finish({ engine });
      else if (error) finish({ unshown: 'unkept' });
    };
    const finish = (answer) => {
      stop();
      timers.clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(answer);
    };
    const abort = () => finish({ unshown: 'unopened' });
    const timer = timers.setTimeout(abort, FIRST_COPY_MS);
    const stop = session.subscribe(check);
    signal.addEventListener('abort', abort, { once: true });
    check();
  });
}

export class ReplicaReading {
  // `room` holds the handles the room's writes reach for; `say` shows the room's toast; `toldRef` is the visit's note that
  // it has told why its roadmap cannot be shown, and `reported` the static names of the server's reads of the roadmap that
  // failed and reported in the visit, which every reading a sign-in or Try again runs in it shares, so each reports once a
  // visit. A reading of no roadmap (`treeId` null) reads the person's roadmaps alone, and asks the server nothing.
  constructor({ treeId, room = null, say = () => {}, session = syncSession, timers = globalThis, report = reportRoadmapFailure, track = beacon,
    toldRef = { current: false }, reported = new Set(), repository = treeId === null ? null : new HttpTreeRepository({ treeId, served: true,
      reportFailure: (operation, ...details) => {
        if (reported.has(operation)) return;
        reported.add(operation);
        report(operation, ...details);
      } }) }) {
    this.treeId = treeId;
    this.scope = treeId === null ? null : RoadmapScopes.tree(treeId);
    this.room = room;
    this.say = say;
    this.session = session;
    this.timers = timers;
    this.report = report;
    this.track = track;
    this.toldRef = toldRef;
    this.repository = repository;
    // The room's status line reads this reading as it reads roadmap's own session; `ready` says a write can be taken.
    this.ready = false;
    this.writes = null;
    this.engine = null;
    this.subscribed = new Set();
    this.subscribing = new Set();
    this.holds = new Map();
    this.listeners = new Set([() => this.emitStatus(), () => this.writes?.followInverses()]);
    this.statusHandlers = new Set();
    this.told = null;
    this.landingFailed = false;
    this.holdings = new Map();
    // What the server's read of the owner's progress said, as a reader's room opened, each subtree its roadmap's steps
    // own has come to, by step (§7): the device holds none of the owner's marks of them.
    this.subtrees = new Map();
    this.last = null;
    this.stopped = new AbortController();
    this.closed = false;
  }

  get status() { return this; }

  // The engine's replica says whose copies these are: nothing is asked of the network first.
  async settleHolder() {}

  // The roadmap as the device holds it once it can be shown, and null where it cannot be, which the room says with its
  // load error and the reading tells (`roadmap_load`): the engine could not open or did not stand within the bound, the
  // person may read no such roadmap here, or no answer came within the bound. A roadmap someone else owns shows its
  // owner's marks and how far each of its subtrees is, as the server reads them. The roadmap's scope is the reading's to
  // drop from the moment it asks for it, so a room that leaves while the engine takes the subscription leaves it unfollowed.
  async read({ signal }) {
    const answer = await this.open(signal);
    if (answer === null) return null;
    if (answer.unshown === 'missing') this.forgetLanding();
    if (answer.unshown) return this.unshown(answer.unshown);
    const { roadmap } = answer;
    this.opened = roadmap;
    this.openWrites(roadmap.mine);
    if (roadmap.mine) return { seed: roadmap.seed, overlay: roadmap.marks, workspace: roadmap.workspace, guides: roadmap.guides };
    const { subtrees, ...overlay } = await this.ownerMarks(roadmap.seed);
    this.subtrees = subtrees;
    return { seed: roadmap.seedOf(this.treeId, subtrees), overlay, workspace: null, guides: roadmap.guides };
  }

  // The owner's marks of a roadmap someone else owns, as the server reads them (`GET /v1/trees/{id}/progress`, §7), or the
  // steps' seeds where that read fails: the device holds none of them. The repository reports the failure, once a visit.
  async ownerMarks(seed) {
    try {
      return await this.repository.loadProgress(seed, { signal: AbortSignal.timeout(FIRST_COPY_MS) });
    } catch {
      return { completed: new Set(seed.nodes.filter((step) => step.status === 'complete').map((step) => step.id)), completedAt: {}, server: false,
        subtrees: new Map() };
    }
  }

  // What an address comes to for the person, for the tree picker, read from the copy as the room reads its roadmap, where
  // today's server answered `GET /v1/trees/{id}` (§7: a device computes it from its copy): its name, how many steps it
  // holds and whether it is theirs. The copy names no author. Null where no roadmap they may read stands there; a copy that
  // did not open, or no answer within the bound, throws as a read the server never answered does (status 0).
  async readCard() {
    const answer = await this.open(this.stopped.signal);
    if (answer?.unshown === 'missing') return null;
    if (!answer?.roadmap) throw Object.assign(new Error('The roadmap at the address was not read'), { status: 0 });
    const { seed } = answer.roadmap;
    return { id: this.treeId, title: seed.title, author: null, steps: seed.nodes.length, mine: seed.mine };
  }

  // The reading's roadmap once the device can say what it is: `{ roadmap }` where it stands open, else `{ unshown }` saying
  // why it cannot be shown (`UNSHOWN`); null where the caller stopped waiting or the reading closed.
  async open(signal) {
    const opened = await standingEngine(this.session, signal, this.timers);
    if (signal.aborted) return null;
    if (!opened.engine) return { unshown: opened.unshown };
    this.engine = opened.engine;
    this.unwatch = this.engine.observeEngine(this.changed);
    this.subscribed.add(this.scope);
    const subscription = await this.engine.subscribe(this.scope);
    if (this.closed) this.engine.unsubscribe(this.scope).catch(() => {});
    if (signal.aborted || this.closed) return null;
    if (subscription === 'gone') return { unshown: 'missing' };
    const roadmap = await this.whenRead(signal, (read) => read.state !== 'waiting');
    if (signal.aborted) return null;
    if (roadmap.state === 'missing') return { unshown: 'missing' };
    if (roadmap.state !== 'open') return { unshown: 'unanswered' };
    return { roadmap };
  }

  // Why the room's roadmap cannot be shown (`UNSHOWN`), told as the reading gives up on it, once a visit.
  unshown(outcome) {
    if (!UNSHOWN.includes(outcome)) throw new TypeError('a roadmap is unshown for a reason UNSHOWN names');
    if (!this.toldRef.current) this.track('roadmap_load', { outcome });
    this.toldRef.current = true;
    return null;
  }

  // Each change the replica draws after the room opened, handed on in the room's shapes; what the device tells of the
  // person's own changes as it opens and after each change; the server's tail of the roadmap's activity once it answers.
  follow({ onTree, onProgress, onWorkspace, onGuides, onLanding, onActivity }) {
    if (this.ready && this.room) this.room.sessionRef.current = this.writes;
    let shown = this.opened;
    let own = this.ready;
    onLanding(this.landing());
    this.listeners.add(() => {
      const roadmap = this.roadmap();
      if (own && (roadmap.state === 'missing' || !roadmap.mine)) this.forgetLanding();
      own = own && roadmap.state !== 'missing' && roadmap.mine;
      if (roadmap === shown || roadmap.state !== 'open') return;
      shown = roadmap;
      onTree(roadmap.seedOf(this.treeId, this.subtrees));
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

  // §6 What the device tells its owner once of their own changes on this roadmap, from the domain's `landingOf`: a line a
  // step, in the room's names; nothing on a roadmap someone else owns. `cameBack` where the person's change brought the
  // step back; `follows` with the names of the deleted steps it was linked from and of the steps it follows through them
  // (null where the device holds none). `told` is what saying the line clears from the device's note. A read that fails
  // tells nothing and reports once, and the room reads on.
  landing() {
    if (!this.ready) return [];
    try {
      const { follows, cameBack, note } = this.writes.runner.read(this.scope, (read) => landingOf(this.treeId, read));
      return [
        ...follows.map(({ node, incoming, removed, followed }) => ({
          key: `follows:${node}:${incoming.map(([from]) => from).join('\n')}`, step: node, rule: 'follows',
          removed: removed.map(({ name }) => name), followed: followed.map(({ name }) => name),
          told: { nodes: note.nodes.includes(node) ? [node] : [], edges: incoming },
        })),
        ...cameBack.map((step) => ({ key: `cameBack:${step}`, step, rule: 'cameBack', told: { revived: [step] } })),
      ];
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

  // The reading found its roadmap gone, or the person's own roadmap left their list: where the domain reads it gone from
  // the list, the device's note of it goes whole, so a roadmap that never opens again keeps no name of its steps here.
  forgetLanding() {
    if (!this.writes) this.openWrites(false);
    this.writes.settle([new ClearLanding(this.treeId, {})], 'landing');
  }

  // The person's roadmaps alone, for a page that lists them (a reading of no roadmap, `treeId` null): once the engine
  // stands, the list as the replica holds it now and after each change, and the write door. False where the engine did
  // not stand within the bound.
  async readRoadmaps({ signal, onList }) {
    this.engine = (await standingEngine(this.session, signal, this.timers)).engine ?? null;
    if (!this.engine || signal.aborted) return false;
    this.unwatch = this.engine.observeEngine(this.changed);
    this.openWrites(false);
    this.listeners.add(() => onList(this.list()));
    onList(this.list());
    return true;
  }

  // The person's roadmaps as the switcher lists them, once the device has read their list, for a door that goes to one of
  // them (`#/app`, to the newest); null where the engine did not stand within the bound, which the reading tells as a room
  // does (`roadmap_load`).
  async readList({ signal }) {
    const opened = await standingEngine(this.session, signal, this.timers);
    if (signal.aborted) return null;
    if (!opened.engine) return this.unshown(opened.unshown);
    this.engine = opened.engine;
    this.unwatch = this.engine.observeEngine(this.changed);
    await this.whenRead(signal, (roadmaps) => roadmaps.listRead);
    return this.list();
  }

  // The person's roadmaps whole, for a reading that takes every one of them (Settings' export; a reading of no roadmap):
  // once the device can say what each is, from the copy it holds or the server's first answer. Null where the engine did
  // not stand within the bound.
  async readEveryRoadmap({ signal }) {
    this.engine = (await standingEngine(this.session, signal, this.timers)).engine ?? null;
    if (!this.engine || signal.aborted) return null;
    this.unwatch = this.engine.observeEngine(this.changed);
    return this.whenRead(signal, (roadmaps) => roadmaps.everyRoadmapRead);
  }

  // The person's roadmaps as the switcher lists them, for a surface that offers the newest back (the home card, the
  // landing; a reading of no roadmap): once the device can say what each is, as `readEveryRoadmap` waits, and again after
  // each change, the account's or, signed out, the browser's own. False where the engine did not stand within the bound.
  async followRoadmaps({ signal, onList }) {
    if (await this.readEveryRoadmap({ signal }) === null || signal.aborted) return false;
    this.listeners.add(() => onList(this.list()));
    onList(this.list());
    return true;
  }

  // The account's roadmaps as the switcher lists them, where the replica keeps them; null before the engine stands, when
  // the device cannot say which roadmaps are the person's.
  list() {
    if (!this.engine) return null;
    return this.roadmap().list(this.engine.getSnapshot().state === 'bound' ? 'account' : 'device');
  }

  // An address of one of the person's roadmaps, as the tree picker reads one: null where the replica keeps no such roadmap
  // of theirs.
  card(id) {
    const row = this.list()?.find((each) => each.id === id);
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
    if (this.closed) return;
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

  // The roadmaps once `read` says the device can say what they are: from the copy it holds, or the server's first answer.
  // Where the engine cannot reach the server, once nothing is left to read from the device, it says what it holds; with
  // no answer within the bound, it stops waiting.
  whenRead(signal, read) {
    return new Promise((resolve) => {
      let roadmap = null;
      const check = () => {
        roadmap = this.roadmap();
        const { connection, authPaused, upgradeRequired } = this.engine.getSnapshot();
        const cut = connection !== 'online' || authPaused || upgradeRequired;
        if (read(roadmap) || (cut && [...this.holds.values()].every(({ hold }) => hold.getSnapshot().loaded))) finish();
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

  // A scope the reading comes to read, subscribed once, so the server's copy of it arrives. Until the engine has taken the
  // subscription it is not read: the engine reads a scope it does not pull as pulled and holding nothing, so a roadmap
  // above the open one would read as empty, and the open one as hidden. A reading that closed while the engine took it
  // drops it again.
  subscribeTo(scope) {
    if (this.subscribed.has(scope)) return;
    this.subscribed.add(scope);
    this.subscribing.add(scope);
    this.engine.subscribe(scope).catch(() => {}).finally(() => {
      this.subscribing.delete(scope);
      if (this.closed) this.engine.unsubscribe(scope).catch(() => {});
      else this.changed();
    });
  }

  // What the replica holds of one roadmap, its tree scope subscribed, the same holding while its records are the same.
  holding(id, record) {
    this.subscribeTo(RoadmapScopes.tree(id));
    const tree = this.observe(RoadmapScopes.tree(id));
    const overlay = this.observe(RoadmapScopes.overlay(id));
    const read = !this.subscribing.has(RoadmapScopes.tree(id)) && tree.firstPullComplete && tree.loaded;
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
