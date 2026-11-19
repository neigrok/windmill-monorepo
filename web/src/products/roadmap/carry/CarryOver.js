// §8.2 The carry-over: on every load while an old store holds anything, and again whenever another replica becomes
// active, under one browser lock across tabs, what roadmap's old bundle kept moves into the engine's replica through
// the domain's actions, and each old entry goes once the ledger in the replica shows it carried (INV-4).
//
// Where a roadmap goes. One made signed out goes to the replica its row names: the active one where it names nobody, as
// the claim the old bundle had begun, and that account's where it names one, waiting until that account is signed in.
// The browser first asks the server whether its id exists: an id the server does not hold becomes a creation under that
// id; one the person's list holds is carried as changes to it; one the server holds for someone else, or as spent, is
// created under a fresh id derived from the old one, and the device's pointers at it move with it. A roadmap the server
// keeps carries its unsent changes to the account its row names, after that roadmap's first pull; one gone from the
// person's list keeps its worded changes for the one list. A roadmap that cannot be placed yet waits for a later load.
//
// What cannot land. Each roadmap's acts are written as one composed act with the ledger last; a part the domain refuses
// is set aside, in the ledger's one list where it is past a bound, past a cap, of a roadmap deleted or of one no longer
// the person's, and dropped otherwise (a link closing a loop, a step the roadmap never held), and the rest are written.

import { Id } from '../../../platform/domain-kit/entities.js';
import { ActionRunner, EngineReplica } from '../../../platform/domain-kit/runner.js';
import { FixedZone } from '../../../platform/domain-kit/time.js';
import { syncSession } from '../../../platform/sync/session.js';
import { restoredDeviceHolder } from '../../../shell/auth/accountChange.js';
import { track as trackEvent } from '../../../telemetry/beacon.js';
import { countBucket } from '../board/acts.js';
import { CarriedIds, CarryLedger, RecordCarry, carryLedgerOf, kept } from '../domain/carry.js';
import { RoadmapKind } from '../domain/kinds.js';
import { HeldRecord, RoadmapScopes } from '../domain/roadmapRules.js';
import { Roadmap } from '../domain/roadmaps.js';
import { RoadmapStep } from '../domain/steps.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { failureTags } from '../sync/localTrees.js';
import { OldStores } from './OldStores.js';

const CARRY_LOCK = 'windmill-roadmap-carry';

// How long the carry-over waits for the server: a first pull, or the answer to whether an id exists.
const ANSWER_MS = 10_000;

// The carry-over's acts read no local date.
const ZONE = new FixedZone(0);

// The one list's reason for a part the domain refused, or null for one dropped.
function keptReason(refusal) {
  if (refusal.kind === 'invalid') return refusal.violation.reason.kind === 'custom' ? null : 'pastBound';
  if (refusal.kind === 'tooLarge') return 'pastBound';
  if (refusal.kind === 'full') return 'capFilled';
  if (refusal.kind === 'roadmapGone') return 'roadmapDeleted';
  if (refusal.kind === 'unreachable') return 'accessEnded';
  return null;
}

export class CarryOver {
  constructor({ session = syncSession, stores = new OldStores(), locks = globalThis.navigator?.locks, timers = globalThis,
    report = reportRoadmapFailure, track = trackEvent } = {}) {
    this.session = session;
    this.stores = stores;
    this.locks = locks;
    this.timers = timers;
    this.report = report;
    this.track = track;
    this.carried = null;
    this.running = Promise.resolve();
    this.stops = [];
  }

  // Runs once the shell's engine stands, and again whenever another replica becomes active: a sign-in or a sign-out, once
  // its question is answered.
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

  consider() {
    const { engine } = this;
    const { replica, pendingSignIn } = engine.getSnapshot();
    if (pendingSignIn || engine.signingOut || engine.device?.meta?.signOut || replica === this.carried) return;
    this.carried = replica;
    this.running = this.running.then(() => this.run(engine)).catch((error) => this.report('roadmap-carry-write', error, { stage: 'run', ...failureTags(error) }));
  }

  // One carry-over, the only one on this browser while it runs.
  run(engine) {
    if (!this.locks) return Promise.resolve();
    return this.locks.request(CARRY_LOCK, () => this.carry(engine));
  }

  async carry(engine) {
    const { roadmaps, unread } = await this.stores.read();
    for (const { store, error } of unread) this.report('roadmap-carry-read', error, { store, ...failureTags(error) });
    if (roadmaps.length === 0) return;
    this.track('roadmap_carry', { stage: 'found', roadmaps: countBucket(roadmaps.filter((each) => each.madeSignedOut).length),
      changed: countBucket(roadmaps.filter((each) => !each.madeSignedOut && each.changed).length),
      workspaces: countBucket(roadmaps.filter((each) => each.workspace !== null).length), marks: countBucket(roadmaps.filter((each) => each.marks !== null).length) });
    const runner = new ActionRunner(new EngineReplica(engine), engine.registry, ZONE);
    const account = restoredDeviceHolder(engine);
    if (!await this.pulled(engine, [RoadmapScopes.account])) {
      this.track('roadmap_carry', { stage: 'waiting', roadmaps: countBucket(roadmaps.length) });
      return;
    }
    const fates = new Map();
    for (const roadmap of roadmaps) fates.set(roadmap, await this.fateOf(engine, runner, roadmap, account));
    const moved = new Map(runner.read(RoadmapScopes.account, (read) => Object.entries(read.devices('carry:'))
      .map(([key, row]) => [key.slice('carry:'.length), CarryLedger.of(row).to]).filter(([, to]) => to !== null)));
    for (const [roadmap, fate] of fates) if (fate.to && fate.to !== roadmap.id) moved.set(roadmap.id, fate.to);
    const opened = (tree) => moved.get(tree) ?? tree;
    const tally = { roadmap: 0, moved: 0, change: 0, mark: 0, item: 0, kept: 0, waiting: 0, gone: 0 };
    for (const [roadmap, fate] of fates) {
      if (fate.kind === 'empty') {
        tally.gone += await this.forget(roadmap);
        continue;
      }
      if (fate.kind === 'wait') {
        tally.waiting += 1;
        continue;
      }
      let carried;
      try {
        carried = await this.carryOne(engine, runner, roadmap, fate, { opened, signedIn: account !== null });
      } catch (error) {
        this.report('roadmap-carry-write', error, { stage: 'carry', ...failureTags(error) });
        carried = null;
      }
      if (carried === null) {
        tally.waiting += 1;
        continue;
      }
      for (const counted of carried.counted) tally[counted] += 1;
      if (fate.kind === 'create' && fate.to !== roadmap.id) tally.moved += 1;
      tally.kept += carried.kept;
      tally.gone += await this.forget(roadmap);
    }
    if (tally.roadmap + tally.change + tally.mark + tally.item + tally.kept > 0) {
      this.track('roadmap_carry', { stage: 'carried', roadmaps: countBucket(tally.roadmap), moved: countBucket(tally.moved), changes: countBucket(tally.change),
        marks: countBucket(tally.mark), items: countBucket(tally.item), kept: countBucket(tally.kept) });
    }
    if (tally.waiting > 0) this.track('roadmap_carry', { stage: 'waiting', roadmaps: countBucket(tally.waiting) });
    if (tally.gone > 0) this.track('roadmap_carry', { stage: 'cleared', stores: countBucket(tally.gone) });
  }

  // The old roadmap's entries, gone once its ledger shows it carried; a store that fails to delete keeps them for the next
  // load. Answers how many went.
  async forget(roadmap) {
    try {
      return await this.stores.forget(roadmap);
    } catch (error) {
      this.report('roadmap-carry-write', error, { stage: 'clear', ...failureTags(error) });
      return 0;
    }
  }

  // Where one old roadmap goes: `{ kind: 'create' | 'changes', to }`, `{ kind: 'lost', reason }` for a roadmap of the
  // server's the person no longer holds, `{ kind: 'empty' }` for a row made signed out whose record the browser no longer
  // holds, or `{ kind: 'wait' }`.
  async fateOf(engine, runner, roadmap, account) {
    const ledger = runner.read(RoadmapScopes.account, (read) => carryLedgerOf(read, roadmap.id));
    if (ledger.to !== null) return { kind: 'changes', to: ledger.to };
    if (roadmap.madeSignedOut && roadmap.record === null) return { kind: 'empty' };
    const owner = roadmap.owner ?? null;
    const placed = owner === null ? roadmap.madeSignedOut || account !== null : owner === account;
    if (!placed) return { kind: 'wait' };
    const listed = (id) => runner.read(RoadmapScopes.account, (read) => {
      const roadmaps = read.repository(Roadmap);
      if (roadmaps.record(id, 'stored')?.life?.[0] === 'alive') return 'alive';
      return roadmaps.record(id, 'stored') !== undefined || roadmaps.spentBorn(new Id(id, Roadmap)) !== null ? 'spent' : null;
    });
    const held = listed(roadmap.id);
    if (!roadmap.madeSignedOut) {
      if (held === 'alive') return { kind: 'changes', to: roadmap.id };
      if (held === 'spent' || (!roadmap.changed && roadmap.workspace === null)) return { kind: 'lost', reason: 'roadmapDeleted' };
      const answer = await this.ask(engine, roadmap.id);
      if (answer === null) return { kind: 'wait' };
      return { kind: 'lost', reason: answer === 'spent' ? 'roadmapDeleted' : 'accessEnded' };
    }
    if (held === 'alive') return { kind: 'changes', to: roadmap.id };
    const answer = held === 'spent' ? 'spent' : await this.ask(engine, roadmap.id);
    if (answer === null) return { kind: 'wait' };
    if (answer === 'none') return { kind: 'create', to: roadmap.id };
    const fresh = CarriedIds.roadmap(roadmap.id);
    return { kind: listed(fresh) === 'alive' ? 'changes' : 'create', to: fresh };
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
      this.report('roadmap-carry-write', error, { stage: 'ask', ...failureTags(error) });
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
  // roadmap has had its first pull, which the anon replica, holding its own roadmaps, never waits for. Answers what each
  // written part counted as and how many records were set aside, or null where the roadmap could not be read in time.
  async carryOne(engine, runner, roadmap, fate, { opened, signedIn }) {
    const ledger = runner.read(RoadmapScopes.account, (read) => carryLedgerOf(read, roadmap.id));
    const entry = { to: fate.to ?? null, items: roadmap.itemDigests, marks: roadmap.marksDigest };
    if (fate.kind === 'lost') {
      const parts = roadmap.changes(roadmap.id, ledger, () => true, opened);
      const words = fate.reason === 'roadmapDeleted' ? [...parts, ...roadmap.workspaceParts(roadmap.id, ledger)] : parts;
      const lost = words.map((each) => kept(roadmap.id, fate.reason, each.subject, each.values, each.named));
      if (lost.length === 0) return { counted: [], kept: 0 };
      return this.write(engine, runner, roadmap.id, [], { ...entry, frontier: roadmap.frontier(ledger), kept: lost });
    }
    if (fate.kind === 'create') {
      const { kept: setAside, parts } = roadmap.creation(fate.to, engine.registry, runner.moment(), opened);
      return this.write(engine, runner, roadmap.id, [...parts, ...roadmap.workspaceParts(fate.to, ledger)], { ...entry, frontier: roadmap.frontier(), kept: setAside });
    }
    const scope = RoadmapScopes.tree(fate.to);
    try {
      if (signedIn && (await engine.subscribe(scope) === 'gone' || !await this.pulled(engine, [scope, RoadmapScopes.overlay(fate.to)]))) return null;
      const knows = (type, id) => runner.read(scope, (read) => HeldRecord.read(read.repository(type === 'kind' ? RoadmapKind : RoadmapStep),
        new Id(id, type === 'kind' ? RoadmapKind : RoadmapStep)).known);
      const parts = [...roadmap.changes(fate.to, ledger, knows, opened), ...roadmap.workspaceParts(fate.to, ledger)];
      return await this.write(engine, runner, roadmap.id, parts, { ...entry, frontier: roadmap.frontier(ledger), kept: [] });
    } finally {
      if (signedIn) await engine.unsubscribe(scope).catch(() => {});
    }
  }

  // The parts and the ledger's entry as one composed act, the ledger last. A part the domain refuses is set aside, kept for
  // the one list where its reason is one, and the rest written again; an act the engine holds is released at once, and
  // the engine keeps no Undo of it.
  async write(engine, runner, old, parts, entry) {
    let standing = parts;
    const setAside = [...entry.kept];
    for (;;) {
      const outcome = await runner.runComposed([...standing.map((each) => each.act), new RecordCarry(old, new CarryLedger({ ...entry, kept: setAside }))]);
      if (outcome.kind === 'refused') {
        const refused = standing[outcome.part];
        if (refused === undefined || refused.counted === 'roadmap') throw new Error(`the carry-over's ${refused ? 'roadmap' : 'ledger'} was refused`);
        const reason = keptReason(outcome.refusal);
        if (reason !== null) setAside.push(kept(old, reason, refused.subject, refused.values, refused.named));
        standing = standing.filter((each) => each !== refused);
        continue;
      }
      if (outcome.kind === 'committed') await this.settle(engine, runner, outcome.receipt);
      return { counted: standing.map((each) => each.counted), kept: setAside.length };
    }
  }

  async settle(engine, runner, receipt) {
    if (receipt.releaseAt !== null) for (const segment of receipt.segments) for (const localId of segment.localIds) await engine.release(localId);
    await runner.release(receipt.gestureId);
  }
}
