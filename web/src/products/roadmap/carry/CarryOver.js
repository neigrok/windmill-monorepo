// §8.2 The carry-over: on every load while an old store holds anything, again whenever another replica becomes active or
// the active one is bound to another account, and again when the connection returns to a run that left roadmaps waiting,
// under one browser lock across tabs, what roadmap's old bundle kept moves into the engine's replica through the domain's
// actions, and each old entry goes once the ledger in the replica shows it carried (INV-4). A run pins the replica it
// starts on and writes only while that replica, bound as it was, is the active one: a sign-in or a sign-out between ends
// the run with every old store whole, and the next replica's run carries it where it belongs.
//
// Where a roadmap goes: only to the replica it belongs to, so nothing reaches an account without the lineage rule's
// question. One made signed out that names nobody goes to the anon replica, and waits while an account is signed in;
// one that names an account, to that account's. One the server answered a claim for (its record holds what the server
// confirmed) goes only to the account whose list holds it, or that deleted it, and so does one whose claim landed
// unanswered, which the account's list holds. The browser first asks the server whether the id exists: an id the server
// does not hold becomes a creation under that id; one the person's list holds is carried as changes to it; one the
// server holds for someone else, or as spent, is created under a fresh id derived from the old one, and the device's
// pointers at it move with it. A roadmap the server keeps carries its unsent changes to the account its row names, or
// whose list holds it, after that roadmap's first pull; one gone from the account's list keeps its worded changes for
// that account's one list. An account's roadmaps wait while the device keeps that account's replica; its sign-out's
// Discard takes those its question named (accountChange.js). A roadmap that cannot be placed yet waits.
//
// A creation keeps its old stores until the server takes it: the anon replica sends nothing, so a roadmap carried into
// it keeps them until a sign-in adds it to an account and the server takes it there. Where the server refuses its id as
// taken or spent, the roadmap is placed again as the account's, from its old stores whole, and the notice goes.
//
// What cannot land. Each roadmap's acts are written as one composed act with the ledger last; a part the domain refuses
// is set aside, in the ledger's one list where it is past a bound, past a cap, of a roadmap deleted or of one no longer
// the person's, and dropped otherwise (a link closing a loop, a step the roadmap never held), and the rest are written.
// A workspace item past its bound is set aside before the act is tried.

import { effectsOf } from '../../../../../packages/api-contract/sync/reference/client/projections.js';
import { Id } from '../../../platform/domain-kit/entities.js';
import { ActionRunner, EngineReplica } from '../../../platform/domain-kit/runner.js';
import { FixedZone } from '../../../platform/domain-kit/time.js';
import { syncSession } from '../../../platform/sync/session.js';
import { track as trackEvent } from '../../../telemetry/beacon.js';
import { countBucket } from '../board/acts.js';
import { CarriedIds, CarryLedger, RecordCarry, carryLedgerOf, kept, listedAs } from '../domain/carry.js';
import { RoadmapKind } from '../domain/kinds.js';
import { HeldRecord, RoadmapScopes } from '../domain/roadmapRules.js';
import { Roadmap } from '../domain/roadmaps.js';
import { RoadmapStep } from '../domain/steps.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { failureTags } from '../sync/SyncStore.js';
import { CarryNotes, OldStores } from './OldStores.js';

const CARRY_LOCK = 'windmill-roadmap-carry';

// How long the carry-over waits for the server: a first pull, the answer to whether an id exists, or to a creation.
const ANSWER_MS = 10_000;

// The carry-over's acts read no local date.
const ZONE = new FixedZone(0);

// The codes the server refuses a roadmap's creation with: its id is someone else's, or spent.
const TAKEN = new Set(['id-taken', 'id-spent']);

// The account whose replica is active: the one the carry-over writes into, null signed out.
function activeAccount(engine) {
  const { state, account } = engine.device.activeReplica.meta;
  return state === 'bound' ? account : null;
}

// The active replica as it is bound, one opaque string: a run pins it as it starts.
function activeBinding(engine) {
  return JSON.stringify([engine.device.activeReplica.id, activeAccount(engine)]);
}

// A run's replica is no longer the active one, or is bound to another account: the run ends there.
export class ReplicaChanged extends Error {
  constructor() {
    super('The active replica changed');
    this.name = 'ReplicaChanged';
  }
}

// The one list's reason for a part the domain refused, or null for one dropped.
function keptReason(refusal) {
  if (refusal.kind === 'invalid') return refusal.violation.reason.kind === 'custom' ? null : 'pastBound';
  if (refusal.kind === 'tooLarge') return 'pastBound';
  if (refusal.kind === 'full') return 'capFilled';
  if (refusal.kind === 'roadmapGone') return 'roadmapDeleted';
  if (refusal.kind === 'unreachable') return 'accessEnded';
  return null;
}

// Whether an entry writes the `tree` record `tree` in the account's list.
function writesTree(entry, tree) {
  return effectsOf(entry).some(({ scope, d }) => scope === RoadmapScopes.account && d.some((delta) => delta.t === Roadmap.type && String(delta.id) === tree));
}

export class CarryOver {
  constructor({ session = syncSession, stores = new OldStores(), notes = new CarryNotes(), locks = globalThis.navigator?.locks, timers = globalThis,
    report = reportRoadmapFailure, track = trackEvent } = {}) {
    this.session = session;
    this.stores = stores;
    this.notes = notes;
    this.locks = locks;
    this.timers = timers;
    this.report = report;
    this.track = track;
    this.binding = null;
    this.connection = null;
    this.unfinished = false;
    this.running = Promise.resolve();
    this.stops = [];
  }

  // Runs once the shell's engine stands, and again as `consider` says.
  start() {
    const watch = () => {
      const { engine, ready } = this.session.getSnapshot();
      if (!ready || !engine || this.engine === engine) return;
      this.engine = engine;
      this.stops.push(engine.observeEngine(() => this.consider()));
      this.consider();
    };
    this.stops.push(this.session.subscribe(watch));
    watch();
  }

  stop() {
    for (const stop of this.stops.splice(0)) stop();
  }

  // A run for each replica that becomes active, or is bound to another account (a sign-in or a sign-out, once its
  // question is answered), and again when the connection comes back to a run that left roadmaps waiting.
  consider() {
    const { engine } = this;
    const { pendingSignIn, connection } = engine.getSnapshot();
    const returned = connection === 'online' && this.connection !== null && this.connection !== 'online';
    this.connection = connection;
    if (pendingSignIn || engine.signingOut || engine.device?.meta?.signOut) return;
    const binding = activeBinding(engine);
    if (binding === this.binding && !(returned && this.unfinished)) return;
    this.binding = binding;
    this.running = this.running.then(() => this.run(engine)).catch((error) => this.report('roadmap-carry-read', error, { store: 'replica', ...failureTags(error) }));
  }

  // One carry-over, the only one on this browser while it runs.
  run(engine) {
    if (!this.locks) return Promise.resolve();
    return this.locks.request(CARRY_LOCK, () => this.carry(engine));
  }

  async carry(engine) {
    const binding = activeBinding(engine);
    const { roadmaps, unread } = await this.stores.read();
    for (const { store, error } of this.notes.unreported(unread)) this.report('roadmap-carry-read', error, { store, ...failureTags(error) });
    const tally = { roadmap: 0, moved: 0, change: 0, mark: 0, item: 0, kept: 0, gone: 0 };
    const waiting = [];
    try {
      if (roadmaps.length > 0 && !await this.pulled(engine, [RoadmapScopes.account])) waiting.push(...roadmaps.map((roadmap) => roadmap.id));
      else if (roadmaps.length > 0) await this.carryEach(engine, binding, roadmaps, tally, waiting);
    } catch (error) {
      if (!(error instanceof ReplicaChanged)) throw error;
      this.unfinished = true;
      this.tell(roadmaps, tally, null);
      return;
    }
    this.unfinished = waiting.length > 0;
    this.tell(roadmaps, tally, waiting);
  }

  // Each old roadmap to where its fate says, in the replica `binding` pins, counted into `tally`; those that cannot be
  // placed yet go to `waiting`.
  async carryEach(engine, binding, roadmaps, tally, waiting) {
    const runner = new ActionRunner(new EngineReplica(engine), engine.registry, ZONE);
    const account = activeAccount(engine);
    const fates = new Map();
    for (const roadmap of roadmaps) fates.set(roadmap, await this.fateOf(engine, runner, roadmap, account));
    const moved = new Map(runner.read(RoadmapScopes.account, (read) => Object.entries(read.devices('carry:'))
      .map(([key, row]) => [key.slice('carry:'.length), CarryLedger.of(row).to]).filter(([, to]) => to !== null)));
    for (const [roadmap, fate] of fates) if (fate.to && fate.to !== roadmap.id) moved.set(roadmap.id, fate.to);
    const opened = (tree) => moved.get(tree) ?? tree;
    for (const [roadmap, fate] of fates) {
      if (fate.kind === 'empty') {
        tally.gone += await this.forget(engine, binding, roadmap);
        continue;
      }
      if (fate.kind === 'wait') {
        waiting.push(roadmap.id);
        continue;
      }
      let carried;
      try {
        carried = await this.carryOne(engine, runner, binding, roadmap, fate, { opened, signedIn: account !== null });
      } catch (error) {
        if (error instanceof ReplicaChanged) throw error;
        this.report('roadmap-carry-write', error, { stage: 'carry', ...failureTags(error) });
        carried = null;
      }
      if (carried === null) {
        waiting.push(roadmap.id);
        continue;
      }
      for (const counted of carried.counted) tally[counted] += 1;
      if (fate.kind === 'create' && fate.to !== roadmap.id) tally.moved += 1;
      tally.kept += carried.kept;
      if (fate.refused) await engine.dismissNotice(fate.refused).catch((error) => this.report('roadmap-carry-write', error, { stage: 'notice', ...failureTags(error) }));
      if (carried.awaiting) {
        waiting.push(roadmap.id);
        continue;
      }
      tally.gone += await this.forget(engine, binding, roadmap);
    }
  }

  // What the run did, as counts. A run that wrote nothing, deleted nothing and leaves waiting what the last run left says
  // nothing, so a browser whose old stores wait on the same thing says it once, not on every load; `waiting` is null for
  // a run its replica's change ended, which leaves the waiting to the next run.
  tell(roadmaps, tally, waiting) {
    const changed = waiting !== null && this.notes.waitingChanged(waiting);
    const wrote = tally.roadmap + tally.change + tally.mark + tally.item + tally.kept > 0;
    if (roadmaps.length === 0 || (!changed && !wrote && tally.gone === 0)) return;
    this.track('roadmap_carry', { stage: 'found', roadmaps: countBucket(roadmaps.filter((each) => each.madeSignedOut).length),
      changed: countBucket(roadmaps.filter((each) => !each.madeSignedOut && each.changed).length),
      workspaces: countBucket(roadmaps.filter((each) => each.workspace !== null).length), marks: countBucket(roadmaps.filter((each) => each.marks !== null).length) });
    if (wrote) {
      this.track('roadmap_carry', { stage: 'carried', roadmaps: countBucket(tally.roadmap), moved: countBucket(tally.moved), changes: countBucket(tally.change),
        marks: countBucket(tally.mark), items: countBucket(tally.item), kept: countBucket(tally.kept) });
    }
    if (changed && waiting.length > 0) this.track('roadmap_carry', { stage: 'waiting', roadmaps: countBucket(waiting.length) });
    if (tally.gone > 0) this.track('roadmap_carry', { stage: 'cleared', stores: countBucket(tally.gone) });
  }

  // The old roadmap's entries, gone once its ledger shows it carried, while the run's replica is still the active one; a
  // store that fails to delete keeps them for the next load. Answers how many went.
  async forget(engine, binding, roadmap) {
    this.standing(engine, binding);
    try {
      return await this.stores.forget(roadmap);
    } catch (error) {
      this.report('roadmap-carry-write', error, { stage: 'clear', ...failureTags(error) });
      return 0;
    }
  }

  // Ends the run where its replica is no longer the active one, bound as it was.
  standing(engine, binding) {
    if (activeBinding(engine) !== binding) throw new ReplicaChanged();
  }

  // Where one old roadmap goes, in the active replica of `account` (null signed out): `{ kind: 'create' | 'changes', to,
  // created, awaiting }`, `created` where the carry-over makes or made `to`, and `awaiting` while the server has not yet
  // taken that creation; `{ kind: 'lost', reason }`
  // for a roadmap of the server's the account no longer holds; `{ kind: 'empty' }` for a row made signed out that has had
  // no record since an earlier load; or `{ kind: 'wait' }` for one that belongs to another replica or cannot be placed
  // yet. A fate carries `refused`, the notice of a creation the server refused, where the roadmap is placed again.
  async fateOf(engine, runner, roadmap, account) {
    const ledger = runner.read(RoadmapScopes.account, (read) => carryLedgerOf(read, roadmap.id));
    if (ledger.to === null) return this.placing(engine, runner, roadmap, account);
    if (!ledger.created) return { kind: 'changes', to: ledger.to, created: false };
    const answer = await this.creationAnswer(engine, ledger.to);
    if (answer.kind === 'refused') return { ...await this.placing(engine, runner, roadmap, account), refused: answer.notice };
    return { kind: 'changes', to: ledger.to, created: true, awaiting: answer.kind === 'pending' };
  }

  // Where one old roadmap goes that no ledger of this replica places.
  async placing(engine, runner, roadmap, account) {
    if (roadmap.madeSignedOut && roadmap.record === null) return this.notes.recordlessBefore(roadmap) ? { kind: 'empty' } : { kind: 'wait' };
    if (typeof roadmap.owner === 'string' && roadmap.owner !== account) return { kind: 'wait' };
    const listed = (id) => runner.read(RoadmapScopes.account, (read) => listedAs(read, id));
    const held = listed(roadmap.id);
    if (held === 'alive' && account !== null) return { kind: 'changes', to: roadmap.id, created: false };
    if (!roadmap.madeSignedOut) {
      if (account === null || roadmap.owner !== account) return { kind: 'wait' };
      if (held === 'spent' || (!roadmap.changed && roadmap.workspace === null)) return { kind: 'lost', reason: 'roadmapDeleted' };
      const answer = await this.ask(engine, roadmap.id);
      if (answer === null) return { kind: 'wait' };
      return { kind: 'lost', reason: answer === 'spent' ? 'roadmapDeleted' : 'accessEnded' };
    }
    const anonymous = roadmap.owner === null && !roadmap.claimBegan;
    if ((anonymous && account !== null) || (roadmap.claimBegan && account === null)) return { kind: 'wait' };
    if (held === 'alive') return { kind: 'changes', to: roadmap.id, created: false };
    const answer = held === 'spent' ? 'spent' : await this.ask(engine, roadmap.id);
    if (answer === null || (roadmap.claimBegan && answer !== 'spent')) return { kind: 'wait' };
    if (answer === 'none') return { kind: 'create', to: roadmap.id, created: true };
    const fresh = CarriedIds.roadmap(roadmap.id);
    return listed(fresh) === 'alive' ? { kind: 'changes', to: fresh, created: false } : { kind: 'create', to: fresh, created: true };
  }

  // Whether the server took the creation of `to` the carry-over made: `pending` while an entry of the replica still
  // writes it, `refused` with the id of the notice that holds its refusal as taken or spent, or `landed`. A pending
  // creation is waited on within the bound while the engine can reach the server; the anon replica sends nothing.
  creationAnswer(engine, to) {
    const answer = () => {
      const replica = engine.device.activeReplica;
      const notice = replica.notices.find((each) => each.scope === RoadmapScopes.account && TAKEN.has(each.code)
        && (each.content?.d ?? []).some((delta) => delta.t === Roadmap.type && String(delta.id) === to));
      if (notice) return { kind: 'refused', notice: notice.id };
      return replica.entries().some((entry) => entry.state !== 'acked' && writesTree(entry, to)) ? { kind: 'pending' } : { kind: 'landed' };
    };
    return new Promise((resolve) => {
      let timer = null;
      let stop = () => {};
      const finish = (found) => {
        this.timers.clearTimeout(timer);
        stop();
        resolve(found);
      };
      const now = answer();
      if (now.kind !== 'pending' || activeAccount(engine) === null || engine.getSnapshot().connection !== 'online') {
        finish(now);
        return;
      }
      timer = this.timers.setTimeout(() => finish(answer()), ANSWER_MS);
      stop = engine.observeEngine(() => {
        const found = answer();
        if (found.kind !== 'pending') finish(found);
      });
    });
  }

  // Whether the server holds a roadmap under `id`, as the engine's pull of its tree answers: `held` where it serves its
  // records, `spent` where the roadmap is gone, `none` where it serves nothing of it, or null with no answer.
  async ask(engine, id) {
    const scope = RoadmapScopes.tree(id);
    try {
      if (await engine.subscribe(scope) === 'gone') return 'spent';
      if (!await this.pulled(engine, [scope])) return null;
      const hold = engine.observe(scope);
      const served = hold.getSnapshot().drawn.length > 0;
      hold.release();
      if (served) return 'held';
      return await engine.subscribe(scope) === 'gone' ? 'spent' : 'none';
    } catch (error) {
      this.report('roadmap-carry-read', error, { store: 'server', ...failureTags(error) });
      return null;
    } finally {
      await engine.unsubscribe(scope).catch(() => {});
    }
  }

  // Whether each scope has had its first pull and its stored rows read within the bound: at once for a scope the replica
  // does not pull, and not at all while the engine cannot reach the server.
  pulled(engine, scopes) {
    const holds = scopes.map((scope) => engine.observe(scope));
    const done = () => holds.every((hold) => {
      const snapshot = hold.getSnapshot();
      return snapshot.firstPullComplete && snapshot.loaded;
    });
    return new Promise((resolve) => {
      const stops = [];
      let timer = null;
      const finish = (answer) => {
        this.timers.clearTimeout(timer);
        for (const stop of stops) stop();
        for (const hold of holds) hold.release();
        resolve(answer);
      };
      if (done() || engine.getSnapshot().connection !== 'online') {
        finish(done());
        return;
      }
      timer = this.timers.setTimeout(() => finish(false), ANSWER_MS);
      for (const hold of holds) stops.push(hold.subscribe(() => { if (done()) finish(true); }));
    });
  }

  // One old roadmap carried as its fate says, and its ledger entry with it: changes on a signed-in replica only once the
  // roadmap has had its first pull, which the anon replica, holding its own roadmaps, never waits for. A roadmap placed
  // again after its creation was refused is carried whole, as though no ledger had carried any of it. Answers what each
  // written part counted as, how many records were set aside and whether its old stores wait for the server to take its
  // creation, or null where the roadmap could not be read in time.
  async carryOne(engine, runner, binding, roadmap, fate, { opened, signedIn }) {
    const ledger = fate.refused ? new CarryLedger() : runner.read(RoadmapScopes.account, (read) => carryLedgerOf(read, roadmap.id));
    const entry = { to: fate.to ?? null, created: fate.created === true, items: roadmap.itemDigests, marks: roadmap.marksDigest };
    if (fate.kind === 'lost') {
      const parts = roadmap.changes(roadmap.id, ledger, () => true, opened);
      const workspace = roadmap.carriedWorkspace(roadmap.id, ledger);
      const words = fate.reason === 'roadmapDeleted' ? [...parts, ...workspace.parts] : parts;
      const lost = [...words.map((each) => kept(roadmap.id, fate.reason, each.subject, each.values, each.named)), ...(fate.reason === 'roadmapDeleted' ? workspace.kept : [])];
      if (lost.length === 0) return { counted: [], kept: 0, awaiting: false };
      return { ...await this.write(engine, runner, binding, roadmap.id, [], { ...entry, frontier: roadmap.frontier(ledger), kept: lost }), awaiting: false };
    }
    if (fate.kind === 'create') {
      const { kept: setAside, parts } = roadmap.creation(fate.to, engine.registry, runner.moment(), opened);
      const workspace = roadmap.carriedWorkspace(fate.to, ledger);
      const written = await this.write(engine, runner, binding, roadmap.id, [...parts, ...workspace.parts],
        { ...entry, frontier: roadmap.frontier(), kept: [...setAside, ...workspace.kept] });
      return { ...written, awaiting: (await this.creationAnswer(engine, fate.to)).kind !== 'landed' };
    }
    const scope = RoadmapScopes.tree(fate.to);
    try {
      if (signedIn && (await engine.subscribe(scope) === 'gone' || !await this.pulled(engine, [scope, RoadmapScopes.overlay(fate.to)]))) return null;
      const knows = (type, id) => runner.read(scope, (read) => HeldRecord.read(read.repository(type === 'kind' ? RoadmapKind : RoadmapStep),
        new Id(id, type === 'kind' ? RoadmapKind : RoadmapStep)).known);
      const workspace = roadmap.carriedWorkspace(fate.to, ledger);
      const parts = [...roadmap.changes(fate.to, ledger, knows, opened), ...workspace.parts];
      return { ...await this.write(engine, runner, binding, roadmap.id, parts, { ...entry, frontier: roadmap.frontier(ledger), kept: workspace.kept }), awaiting: fate.awaiting === true };
    } finally {
      if (signedIn) await engine.unsubscribe(scope).catch(() => {});
    }
  }

  // The parts and the ledger's entry as one composed act, the ledger last, written while the run's replica is the active
  // one. A part the domain refuses is set aside, kept for the one list where its reason is one, and the rest written
  // again; an act the engine holds is released at once, and the engine keeps no Undo of it. Answers what each written
  // part counted as and how many records were set aside.
  async write(engine, runner, binding, old, parts, entry) {
    let standing = parts;
    const setAside = [...entry.kept];
    for (;;) {
      this.standing(engine, binding);
      const outcome = await runner.runComposed([...standing.map((each) => each.act), new RecordCarry(old, new CarryLedger({ ...entry, kept: setAside }))], { binding });
      if (outcome.kind === 'refused') {
        const refused = standing[outcome.part];
        if (refused === undefined || refused.counted === 'roadmap') throw new Error(`the carry-over's ${refused ? 'roadmap' : 'ledger'} was refused`);
        const reason = keptReason(outcome.refusal);
        if (reason !== null) setAside.push(kept(old, reason, refused.subject, refused.values, refused.named));
        standing = standing.filter((each) => each !== refused);
        continue;
      }
      if (outcome.kind === 'committed' && activeBinding(engine) === binding) await this.settle(engine, runner, outcome.receipt);
      return { counted: standing.map((each) => each.counted), kept: setAside.length };
    }
  }

  async settle(engine, runner, receipt) {
    if (receipt.releaseAt !== null) for (const segment of receipt.segments) for (const localId of segment.localIds) await engine.release(localId);
    await runner.release(receipt.gestureId);
  }
}
