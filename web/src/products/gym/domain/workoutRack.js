// @ts-check

import { Decision } from '../../../platform/domain-kit/actions.js';
import { Id, sameJson } from '../../../platform/domain-kit/entities.js';
import { Plan } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Instant } from '../../../platform/domain-kit/time.js';
import { Path, precondition } from '../../../platform/domain-kit/values.js';
import { Exercise } from './catalogue.js';
import { GymRefusals } from './gymRules.js';
import { Routine } from './routines.js';
import { Session, SetRules, TrainingSet, TrainingSetValue } from './training.js';
import { AppendSet, FinishSession, StartSession, TrainingState } from './trainingActions.js';
import { LastTime, Prefill, TrainingLog } from './trainingReads.js';
import { ReviseWorkoutPlan, WorkoutPlan } from './workoutPlan.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/actions.js').IDSource} IDSource */
/** @typedef {import('./catalogue.js').ExerciseValue} ExerciseValue */
/** @typedef {import('./training.js').SessionValue} SessionValue */
/** @typedef {import('./routines.js').PlanSnapshot} PlanSnapshot */
/** @typedef {import('./routines.js').RoutineValue} RoutineValue */
/** @typedef {import('./workoutPlan.js').PlanOperation} PlanOperation */
/** @typedef {Id<ExerciseValue>} ExerciseId */
/** @typedef {Id<SessionValue>} SessionId */

/** @param {readonly ExerciseId[]} ids @param {ExerciseId} id */
const holds = (ids, id) => ids.some((each) => each.equals(id));
/** @param {readonly ExerciseId[]} ids */
const distinct = (ids) => ids.filter((id, at) => !ids.slice(0, at).some((before) => before.equals(id)));

// What the rack holds: the load and reps Log set logs next, whether the lifter set them, and what filled it: the movement,
// how many of its sets were logged then and the last of them (`slot`), and its plan entry (`target`).
export class RackLoad {
  /**
   * @param {{ exerciseId: ExerciseId, weightKg: number, reps: number, touched?: boolean, slot: string, target?: Json }} parts
   */
  constructor({ exerciseId, weightKg, reps, touched = false, slot, target = null }) {
    this.exerciseId = exerciseId;
    this.weightKg = weightKg;
    this.reps = reps;
    this.touched = touched;
    this.slot = slot;
    this.target = target;
    Object.freeze(this);
  }

  // A row this device wrote; anything else reads as no rack, which the workout fills again.
  /** @param {Json} json */
  static decode(json) {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
    const { exerciseId, weightKg, reps, touched, slot, target } = json;
    if (typeof exerciseId !== 'string' || typeof weightKg !== 'number' || !Number.isFinite(weightKg) || typeof reps !== 'number'
      || !Number.isInteger(reps) || typeof slot !== 'string') return null;
    return new RackLoad({ exerciseId: new Id(exerciseId, Exercise), weightKg, reps, touched: touched === true, slot, target: target ?? null });
  }

  /** @param {{ weightKg?: number, reps?: number, touched?: boolean, slot?: string, target?: Json }} changes */
  with(changes) { return new RackLoad({ ...this, ...changes }); }

  // The same set on offer: one movement, one load, one count of reps.
  /** @param {RackLoad | null} other */
  offers(other) {
    return other !== null && this.exerciseId.equals(other.exerciseId) && this.weightKg === other.weightKg && this.reps === other.reps;
  }

  /** @returns {Json} */
  get json() {
    return { exerciseId: this.exerciseId.json, weightKg: this.weightKg, reps: this.reps, touched: this.touched, slot: this.slot, target: this.target };
  }
}

// The rows a device keeps for its open workout (engine A.2, gym's device rows): the movements in their order, the one in
// hand, what the rack holds and the id of the set Log set writes next.
export class RackRows {
  /** @param {{ order?: readonly ExerciseId[], movement?: ExerciseId | null, rack?: RackLoad | null, offer?: string | null }} rows */
  constructor({ order = [], movement = null, rack = null, offer = null } = {}) {
    this.order = Object.freeze([...order]);
    this.movement = movement;
    this.rack = rack;
    this.offer = offer;
    Object.freeze(this);
  }

  static none = new RackRows();

  /** @param {string} session */
  static keys(session) {
    return Object.freeze({ order: `movementOrder:${session}`, movement: `movement:${session}`, rack: `rack:${session}`, offer: `offer:${session}` });
  }

  /** @param {Reader} read @param {SessionId} id */
  static of(read, id) {
    const keys = RackRows.keys(String(id.record));
    const order = read.device(keys.order), movement = read.device(keys.movement), offer = read.device(keys.offer);
    return new RackRows({
      order: Array.isArray(order) ? order.flatMap((each) => typeof each === 'string' ? [new Id(each, Exercise)] : []) : [],
      movement: typeof movement === 'string' ? new Id(movement, Exercise) : null,
      rack: RackLoad.decode(read.device(keys.rack)),
      offer: typeof offer === 'string' ? offer : null,
    });
  }

  /** @param {{ order?: readonly ExerciseId[], movement?: ExerciseId | null, rack?: RackLoad | null, offer?: string | null }} changes */
  with(changes) { return new RackRows({ ...this, ...changes }); }

  /** @returns {{ order: Json, movement: Json, rack: Json, offer: Json }} */
  get rows() {
    return { order: this.order.length === 0 ? null : this.order.map((id) => id.json), movement: this.movement?.json ?? null,
      rack: this.rack?.json ?? null, offer: this.offer };
  }
}

// The open workout as its rack reads it: the session as drawn, its sets in logged order, the account's log for last
// times, the rows this device keeps for it, whether a record already holds the id on offer, and the rows kept for any
// other workout, which no longer needs them.
export class WorkoutRack {
  /**
   * @param {{ id: SessionId, session: SessionValue | null, sets: readonly TrainingSetValue[], log: TrainingLog, rows: RackRows,
   *   offerTaken: boolean, strays?: readonly string[] }} parts
   */
  constructor({ id, session, sets, log, rows, offerTaken, strays = [] }) {
    this.id = id;
    this.session = session;
    this.sets = Object.freeze([...sets]);
    this.log = log;
    this.rows = rows;
    this.offerTaken = offerTaken;
    this.strays = Object.freeze([...strays]);
    Object.freeze(this);
  }

  /** @param {Reader} read @param {SessionId} id */
  static of(read, id) {
    const log = new TrainingLog(read);
    const rows = RackRows.of(read, id);
    return new WorkoutRack({ id, session: log.drawnSessions.find((session) => session.id.equals(id)) ?? null, sets: log.setsFor(id), log, rows,
      offerTaken: rows.offer !== null && read.repository(TrainingSet).record(rows.offer, 'stored') !== undefined,
      strays: Object.keys(read.devices('movementOrder:')).map((key) => key.slice('movementOrder:'.length)).filter((session) => session !== id.record) });
  }

  get isOpen() { return this.session?.isOpen === true; }

  // The workout once `set` has landed on it, the set on offer spent if the set took its id.
  /** @param {TrainingSetValue} set */
  logged(set) {
    return new WorkoutRack({ ...this, sets: [...this.sets, set], offerTaken: this.offerTaken || set.id.record === this.rows.offer });
  }

  // The workout under a plan the same write gives it.
  /** @param {PlanSnapshot} plan */
  planned(plan) {
    precondition(this.session !== null, 'a planned workout is drawn');
    return new WorkoutRack({ ...this, session: this.session.with({ plan }) });
  }

  /** @param {ExerciseId} exerciseId */
  entry(exerciseId) { return this.session?.plan?.entries.find((entry) => entry.exerciseId.equals(exerciseId)) ?? null; }

  /** @param {ExerciseId} exerciseId */
  setsOf(exerciseId) { return this.sets.filter((set) => set.exerciseId.equals(exerciseId)); }

  // Last time, once the account's whole log is here; before its first pull the rack claims none.
  /** @param {ExerciseId} exerciseId */
  lastTime(exerciseId) { return this.log.firstPullComplete ? this.log.lastTime(exerciseId) : new LastTime(exerciseId, null, [], false); }

  // The rows as the workout stands, from `rows` (by default the stored ones): the plan's movements in its order, then each
  // other movement the rows hold, of a workout with no plan or with a set, then each other with a set; the one in hand,
  // else the latest set's, else the first; its rack, kept while the movement's slot holds and, unless the lifter set it,
  // its plan entry too, and filled again otherwise; and the set on offer, which stands while the rack offers the set the
  // stored offer was made for and no record holds its id. `mint` names a new one; a read leaves it null.
  /** @param {(() => string) | null} mint @param {RackRows} rows */
  settled(mint = null, rows = this.rows) {
    const session = this.session;
    if (session === null || !session.isOpen) return RackRows.none;
    const planned = session.plan?.entries.map((entry) => entry.exerciseId) ?? [];
    const logged = distinct(this.sets.map((set) => set.exerciseId));
    const kept = rows.order.filter((id) => holds(logged, id) || (session.plan === null && this.log.catalogue.find(id) !== null));
    const order = distinct([...planned, ...kept, ...logged]);
    const movement = rows.movement !== null && holds(order, rows.movement) ? rows.movement : this.sets.at(-1)?.exerciseId ?? order[0] ?? null;
    if (movement === null) return new RackRows({ order });
    const ofMovement = this.setsOf(movement);
    const slot = `${ofMovement.length}:${ofMovement.at(-1)?.id.record ?? ''}`;
    const target = this.entry(movement)?.json ?? null;
    const held = rows.rack;
    const stands = held !== null && held.exerciseId.equals(movement) && held.slot === slot;
    const rack = stands && (held.touched || sameJson(held.target, target)) ? held.with({ target })
      : this.prefilled(movement, slot, target);
    const offer = this.rows.offer !== null && !this.offerTaken && rack.offers(this.rows.rack) ? this.rows.offer : mint?.() ?? null;
    return new RackRows({ order, movement, rack, offer });
  }

  /** @param {ExerciseId} movement @param {string} slot @param {Json} target */
  prefilled(movement, slot, target) {
    const prefill = Prefill.of(this.setsOf(movement), this.entry(movement), this.log.firstPullComplete ? this.log.lastTime(movement) : null);
    return new RackLoad({ exerciseId: movement, weightKg: prefill.weightKg, reps: prefill.reps, slot, target });
  }

  // Whether the rows stand as the workout settles them; false asks for a write.
  get isSettled() {
    const settled = this.settled();
    return this.strays.length === 0 && sameJson(settled.rows, this.rows.rows) && (settled.rack === null || settled.offer !== null);
  }

  // Each of this workout's rows `next` changes, and each row of another workout, written into `plan`; true if any.
  /** @param {Plan} plan @param {RackRows} next */
  written(plan, next) {
    const before = this.rows.rows, after = next.rows;
    const keys = RackRows.keys(String(this.id.record));
    const changed = /** @type {const} */ (['order', 'movement', 'rack', 'offer']).filter((row) => !sameJson(before[row], after[row]));
    changed.forEach((row) => plan.device(keys[row], after[row]));
    for (const session of this.strays) Object.values(RackRows.keys(session)).forEach((key) => plan.device(key, null));
    return changed.length > 0 || this.strays.length > 0;
  }
}

/** @param {SessionId} sessionId */
const stale = (sessionId) => GymRefusals.ofRefused(new Refused('stale', sessionId.ref, null, 'predicted'));

// A start from a routine the log draws, or an empty one: the shared domain's StartSession, which refuses a start beside
// an open workout. A routine the log no longer draws is gone.
/** @param {{ id: SessionId, routineId: Id<RoutineValue> | null }} input */
export function StartWorkout({ id, routineId }) {
  const start = StartSession({ id, routineId });
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return { start: start.load(read), drawn: routineId === null || read.repository(Routine).find(routineId, 'drawn') !== null }; },
    /** @param {{ start: ReturnType<typeof start.load>, drawn: boolean }} loaded */
    decide({ start: loaded, drawn }) {
      if (!drawn && routineId !== null) return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-record', routineId.ref, null, 'predicted')));
      return start.decide(loaded);
    },
  });
}

// The rows written as the workout stands, once: a tab drawing the workout writes them, and a second tab finds them settled.
/** @param {SessionId} sessionId */
export function SettleRack(sessionId) {
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return WorkoutRack.of(read, sessionId); },
    /** @param {WorkoutRack} rack @param {IDSource} ids */
    decide(rack, ids) {
      const plan = new Plan();
      return rack.written(plan, rack.settled(() => String(ids.mint(TrainingSet).record))) ? Decision.write(plan, null) : Decision.unchanged(null);
    },
  });
}

// One change of the rack, read and written in one write so a tab never writes over another's (web-device-parity §4):
// the movement in hand, a movement a workout with no plan takes, or the load or reps the lifter set.
/**
 * @param {SessionId} sessionId
 * @param {{ movement: ExerciseId } | { adding: ExerciseId } | { weightKg: number } | { reps: number }} change
 */
export function TurnRack(sessionId, change) {
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return WorkoutRack.of(read, sessionId); },
    /** @param {WorkoutRack} rack @param {IDSource} ids */
    decide(rack, ids) {
      if (!rack.isOpen) return Decision.refuse(GymRefusals.ofRefused(new Refused('session-finished', sessionId.ref, null, 'predicted')));
      const rows = rack.settled();
      /** @type {RackRows} */
      let turned;
      if ('movement' in change) {
        if (!holds(rows.order, change.movement)) return Decision.refuse(stale(sessionId));
        turned = rows.with({ movement: change.movement });
      } else if ('adding' in change) {
        if (rack.log.catalogue.find(change.adding) === null) {
          return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-exercise', sessionId.ref, null, 'predicted')));
        }
        if (rack.session?.plan !== null) return Decision.refuse(stale(sessionId));
        turned = rows.with({ order: distinct([...rows.order, change.adding]), movement: change.adding });
      } else {
        if (rows.rack === null) return Decision.refuse(stale(sessionId));
        turned = rows.with({ rack: 'weightKg' in change
          ? rows.rack.with({ weightKg: SetRules.weightKg.apply(change.weightKg, new Path('weightKg')), touched: true })
          : rows.rack.with({ reps: SetRules.reps.apply(change.reps, new Path('reps')), touched: true }) });
      }
      const plan = new Plan();
      return rack.written(plan, rack.settled(() => String(ids.mint(TrainingSet).record), turned)) ? Decision.write(plan, null) : Decision.unchanged(null);
    },
  });
}

// Log set: the set the rack offers, under the id its offer row holds, so a second tap on the same offer, in this tab or
// another, finds the set written and writes nothing. An offer the rows no longer hold is stale. The load and reps are the
// ones the lifter saw; the set lands after the latest, and the rack fills for the next slot under a new offer.
/** @param {{ sessionId: SessionId, offer: string, weightKg: number, reps: number }} input */
export function LogRackSet({ sessionId, offer, weightKg, reps }) {
  const id = new Id(offer, TrainingSet);
  return Object.freeze({
    scope: TrainingSet.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) {
      return { state: new TrainingState(read), rack: WorkoutRack.of(read, sessionId), written: read.repository(TrainingSet).record(offer, 'stored') !== undefined };
    },
    /** @param {{ state: TrainingState, rack: WorkoutRack, written: boolean }} loaded @param {IDSource} ids */
    decide({ state, rack, written }, ids) {
      if (written) return Decision.unchanged(id);
      const movement = rack.rows.movement;
      if (rack.rows.offer !== offer || movement === null) return Decision.refuse(stale(sessionId));
      const latest = Math.max(0, ...rack.sets.map((set) => set.completedAt.ms));
      const at = new Instant(state.moment.now.ms > latest ? state.moment.now.ms : latest + 1);
      const value = new TrainingSetValue(id, sessionId, movement, weightKg, reps, at);
      const decided = AppendSet(value).decide(state, ids);
      if (decided.kind !== 'write') return decided;
      const landed = rack.logged(value);
      landed.written(decided.plan, landed.settled(() => String(ids.mint(TrainingSet).record)));
      return Decision.write(decided.plan, id);
    },
  });
}

// An edit of this workout's plan (`ReviseWorkoutPlan`, stale against any plan but `base`) and the rows it leaves, in one
// write: a movement the edit brings in, alone or in another's place, is the one in hand.
/** @param {{ sessionId: SessionId, base: PlanSnapshot | null, operations: readonly PlanOperation[] }} input */
export function ReviseWorkout({ sessionId, base, operations }) {
  const revising = ReviseWorkoutPlan({ sessionId, base, operations });
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return { workout: revising.load(read), rack: WorkoutRack.of(read, sessionId) }; },
    /** @param {{ workout: ReturnType<typeof revising.load>, rack: WorkoutRack }} loaded @param {IDSource} ids */
    decide({ workout, rack }, ids) {
      const decided = revising.decide(workout);
      if (decided.kind !== 'write') return decided;
      const revision = new WorkoutPlan(workout.plan, workout, sessionId.ref).revised(operations);
      precondition(revision.kind === 'revised', 'the revision ReviseWorkoutPlan wrote revises');
      const before = workout.plan.entries.map((entry) => entry.exerciseId);
      const [brought, ...others] = revision.plan.entries.map((entry) => entry.exerciseId).filter((exerciseId) => !holds(before, exerciseId));
      const revised = rack.planned(revision.plan);
      const rows = revised.settled();
      revised.written(decided.plan, revised.settled(() => String(ids.mint(TrainingSet).record),
        brought !== undefined && others.length === 0 ? rows.with({ movement: brought }) : rows));
      return decided;
    },
  });
}

// Finish: the shared domain's FinishSession, and the rows the workout kept go with it.
/** @param {SessionId} sessionId */
export function FinishWorkout(sessionId) {
  const finishing = FinishSession({ id: sessionId });
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return { state: finishing.load(read), rack: WorkoutRack.of(read, sessionId) }; },
    /** @param {{ state: TrainingState, rack: WorkoutRack }} loaded */
    decide({ state, rack }) {
      const decided = finishing.decide(state);
      if (decided.kind === 'write') rack.written(decided.plan, RackRows.none);
      return decided;
    },
  });
}
