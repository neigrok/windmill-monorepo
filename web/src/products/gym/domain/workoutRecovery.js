// @ts-check

import { Decision, decision } from '../../../platform/domain-kit/actions.js';
import { sameJson } from '../../../platform/domain-kit/entities.js';
import { Plan } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation, precondition } from '../../../platform/domain-kit/values.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { GymRefusals } from './gymRules.js';
import { Session, SessionRules, SessionValue, SetRules, TrainingSet, TrainingSetValue } from './training.js';
import { AppendSet, CorrectedSet, CorrectSession, TrainingState } from './trainingActions.js';
import { SignedOutWorkout } from './workoutAdoption.js';

/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/time.js').Instant} Instant */
/** @typedef {import('../../../platform/domain-kit/time.js').Moment} Moment */
/** @typedef {import('../../../platform/domain-kit/actions.js').IDSource} IDSource */
/** @typedef {import('../../../platform/domain-kit/entities.js').Id<SessionValue>} SessionId */
/** @typedef {import('./catalogue.js').Catalogue} Catalogue */
/** @typedef {import('./catalogue.js').ExerciseValue} ExerciseValue */
/** @typedef {import('./trainingReads.js').TrainingLog} TrainingLog */
/** @typedef {import('./gymRules.js').GymRefusal} GymRefusal */
/** @typedef {import('../../../platform/domain-kit/refusals.js').DomainNotice<GymRefusal>} GymNotice */
// Why a saved workout is still on this device; the value is the bounded label telemetry carries, and copy is the surface's.
/** @typedef {'session-open' | 'session-overlap' | 'id-taken' | 'bad-instant' | 'too-many-sets' | 'invalid-set' | 'unknown-exercise' | 'session-finished' | 'unsent' | 'other'} RecoveryReason */
// Which action a retry runs: the import of a finished copy, the start of an open one, or the sets a landed workout refused.
/** @typedef {'importWorkout' | 'restartWorkout' | 'restoreSets'} RecoveryRetry */

/** @param {GymRefusal} refusal @returns {RecoveryReason} */
export function recoveryReason(refusal) {
  switch (refusal.kind) {
    case 'sessionOpen': return 'session-open';
    case 'sessionOverlap': return 'session-overlap';
    case 'taken': case 'payloadConflict': return 'id-taken';
    case 'badInstant': return 'bad-instant';
    case 'invalid':
      if (refusal.violation.rule === 'session.sets') return 'too-many-sets';
      if (['session.startedAt', 'session.finishedAt', 'set.completedAt'].includes(refusal.violation.rule)) return 'bad-instant';
      return 'invalid-set';
    case 'unknownExercise': return 'unknown-exercise';
    case 'sessionFinished': return 'session-finished';
    default: return 'other';
  }
}

// A signed-out workout the account has not taken: why it is still on this device, what a retry does and the sets it would
// move. `movementNames` holds each of its movements the catalogue names, by the movement's id in JCS.
export class WorkoutRecovery {
  /**
   * @param {{ workout: SignedOutWorkout, reason: RecoveryReason, refusal: GymRefusal | null, retry: RecoveryRetry,
   *   noticeIds: readonly string[], strandedSets: readonly TrainingSetValue[], movementNames: ReadonlyMap<string, string> }} input
   */
  constructor({ workout, reason, refusal, retry, noticeIds, strandedSets, movementNames }) {
    this.workout = workout;
    this.reason = reason;
    this.refusal = refusal;
    this.retry = retry;
    this.noticeIds = Object.freeze([...noticeIds]);
    this.strandedSets = Object.freeze([...strandedSets]);
    this.movementNames = movementNames;
    Object.freeze(this);
  }

  get id() { return this.workout.session.id; }
  // The copy is the device's to correct, except that a spent identity stays spent whatever the copy says.
  get canFix() { return this.reason !== 'id-taken'; }

  // Every saved workout the account has not taken and nothing is carrying: refused by a notice it owns, refused by this
  // device, or never sent. A retry dismisses the notices it answers, so a dismissed notice says nothing here; the newest
  // live one is the reason. A workout drawn on the log is there or on its way, and waits only on its own sets the log
  // does not draw: with none missing it is still adding, or confirmed and about to leave.
  /**
   * @param {readonly SignedOutWorkout[]} workouts @param {readonly GymNotice[]} notices @param {TrainingLog} log
   * @param {Catalogue} catalogue
   */
  static review(workouts, notices, log, catalogue) {
    const sessions = log.drawnSessions;
    return Object.freeze(workouts.flatMap((workout) => {
      const live = notices.filter((notice) => workout.owns(notice) && notice.notice.dismissed !== true);
      const movementNames = new Map(workout.sets.flatMap((set) => {
        const name = catalogue.find(set.exerciseId)?.name;
        return name === undefined ? [] : [[jcs(set.exerciseId.json), name]];
      }));
      /** @param {RecoveryReason} reason @param {GymRefusal | null} refusal @param {RecoveryRetry} retry @param {readonly TrainingSetValue[]} stranded */
      const reviewed = (reason, refusal, retry, stranded) => new WorkoutRecovery({ workout, reason, refusal, retry,
        noticeIds: live.map((notice) => notice.id), strandedSets: stranded, movementNames });
      const latest = live.at(-1);
      if (sessions.some((session) => session.id.equals(workout.session.id))) {
        const missing = workout.sets.filter((set) => !log.sets.some((drawn) => drawn.id.equals(set.id)));
        if (missing.length === 0) return [];
        if (latest === undefined) return [reviewed('unsent', null, 'restoreSets', missing)];
        return [reviewed(recoveryReason(latest.refusal), latest.refusal, 'restoreSets', missing)];
      }
      const retry = workout.session.isOpen ? 'restartWorkout' : 'importWorkout';
      if (latest !== undefined && WorkoutRecovery.stands(latest.refusal, workout, log)) {
        return [reviewed(recoveryReason(latest.refusal), latest.refusal, retry, [])];
      }
      const refusal = workout.retryRefusal(log.moment, sessions, catalogue);
      if (refusal !== null) return [reviewed(recoveryReason(refusal), refusal, retry, [])];
      return [reviewed('unsent', null, retry, [])];
    }));
  }

  // A notice names what held the copy back when the account answered. While the device's log is complete it can tell
  // that the account's open workout has closed, or that the workout the copy crossed no longer crosses it; then the
  // notice no longer stands, and the copy's own state is its reason. A workout the log does not draw may be one the
  // device has not pulled yet, so a crossing with it stands.
  /** @param {GymRefusal} refusal @param {SignedOutWorkout} workout @param {TrainingLog} log */
  static stands(refusal, workout, log) {
    if (!log.firstPullComplete) return true;
    const sessions = log.drawnSessions;
    if (refusal.kind === 'sessionOpen') return sessions.some((session) => session.isOpen && !session.id.equals(workout.session.id));
    if (refusal.kind !== 'sessionOverlap') return true;
    const { detail } = refusal.refused;
    const named = detail !== null && typeof detail === 'object' && !Array.isArray(detail) ? detail.sessionId : undefined;
    const other = named === undefined ? undefined : sessions.find((session) => sameJson(session.id.json, named));
    return other === undefined || SessionRules.crosses(workout.session.startedAt, workout.finishedAt, other);
  }
}

// One set of a saved workout as its editor holds it.
export class SetFix {
  /**
   * @param {{ id: import('../../../platform/domain-kit/entities.js').Id<TrainingSetValue>, exerciseId: import('../../../platform/domain-kit/entities.js').Id<ExerciseValue>,
   *   weightKg: number, reps: number, rpe: number | null, note: string, completedAt: Instant }} input
   */
  constructor({ id, exerciseId, weightKg, reps, rpe, note, completedAt }) {
    this.id = id;
    this.exerciseId = exerciseId;
    this.weightKg = weightKg;
    this.reps = reps;
    this.rpe = rpe;
    this.note = note;
    this.completedAt = completedAt;
    Object.freeze(this);
  }

  /** @param {TrainingSetValue} set */
  static of(set) {
    return new SetFix({ id: set.id, exerciseId: set.exerciseId, weightKg: set.weightKg, reps: set.reps, rpe: set.rpe, note: set.note, completedAt: set.completedAt });
  }

  /** @param {SessionId} session */
  set(session) {
    return new TrainingSetValue(this.id, session, this.exerciseId, this.weightKg, this.reps, this.completedAt, this.rpe, this.note);
  }
}

// The editor over a saved workout the account refused: its times, its routine link and each set, or, once the workout is
// on the log, its stranded sets alone, since its times and routine are the log's. `workout` is the corrected copy a retry
// submits; a set is removed by taking it out of `sets`.
export class WorkoutFix {
  /**
   * @param {{ original: SignedOutWorkout, landed: boolean, startedAt: Instant, finishedAt: Instant | null, keepsRoutine: boolean,
   *   sets: readonly SetFix[], edited: readonly string[] }} input
   */
  constructor({ original, landed, startedAt, finishedAt, keepsRoutine, sets, edited }) {
    this.original = original;
    this.landed = landed;
    this.startedAt = startedAt;
    this.finishedAt = finishedAt;
    this.keepsRoutine = keepsRoutine;
    this.sets = Object.freeze([...sets]);
    this.edited = Object.freeze([...edited]);
    Object.freeze(this);
  }

  /** @param {SignedOutWorkout} workout @param {readonly TrainingSetValue[]} editing @param {boolean} landed */
  static editing(workout, editing, landed) {
    return new WorkoutFix({ original: workout, landed, startedAt: workout.session.startedAt, finishedAt: workout.session.finishedAt,
      keepsRoutine: workout.session.routineId !== null, sets: editing.map(SetFix.of), edited: editing.map((set) => jcs(set.id.json)) });
  }

  /** @param {SignedOutWorkout} workout */
  static of(workout) { return WorkoutFix.editing(workout, workout.sets, false); }

  /** @param {WorkoutRecovery} recovery */
  static ofRecovery(recovery) {
    const landed = recovery.retry === 'restoreSets';
    return WorkoutFix.editing(recovery.workout, landed ? recovery.strandedSets : recovery.workout.sets, landed);
  }

  /** @param {{ startedAt?: Instant, finishedAt?: Instant | null, keepsRoutine?: boolean, sets?: readonly SetFix[] }} changes */
  with(changes) { return new WorkoutFix({ ...this, ...changes }); }

  get hasRoutine() { return this.original.session.routineId !== null; }
  get isOpen() { return this.finishedAt === null; }
  get isChanged() { return !sameJson(this.workout.json, this.original.json); }

  // Finished at its last set, or at its start when it has none.
  markFinished() {
    return this.with({ finishedAt: this.sets.reduce((latest, set) => set.completedAt.ms > latest.ms ? set.completedAt : latest, this.startedAt) });
  }

  get workout() {
    const saved = this.original.session;
    const { finishedAt, keepsRoutine } = this;
    const closedBy = finishedAt === null ? null : finishedAt.ms === saved.finishedAt?.ms ? saved.closedBy : 'finish';
    const session = new SessionValue(saved.id, this.startedAt, finishedAt, closedBy, keepsRoutine ? saved.routineId : null,
      keepsRoutine ? saved.historyRoutineId : null, keepsRoutine ? saved.plan : null, saved.displayName, keepsRoutine ? saved.unreadablePlan : null);
    const kept = this.original.sets.filter((set) => !this.edited.includes(jcs(set.id.json)));
    return new SignedOutWorkout(session, [...kept, ...this.sets.map((set) => set.set(session.id))]);
  }

  // The editor's live line: what this device would refuse before asking the account. A load the person changed meets its
  // floor; a landed workout's sets must be valid and on known movements; a whole copy passes what its retry would meet.
  /** @param {Moment} moment @param {readonly SessionValue[]} sessions @param {Catalogue} catalogue @returns {GymRefusal | null} */
  refusal(moment, sessions, catalogue) {
    const floor = this.workout.floorRefusal(this.original, catalogue);
    if (floor !== null) return floor;
    if (!this.landed) return this.workout.retryRefusal(moment, sessions, catalogue);
    for (const fix of this.sets) {
      try { new Valid(fix.set(this.original.session.id), moment); }
      catch (error) {
        if (error instanceof Violation) return GymRefusals.ofViolation(error);
        throw error;
      }
      if (catalogue.find(fix.exerciseId) === null) return GymRefusals.ofRefused(new Refused('unknown-exercise', fix.id.ref, null, 'predicted'));
    }
    return null;
  }
}

// A start that lost a race with another device's is refused `session-open`, and the sets logged under it live only in its
// notice. This saves them as a copy under the device key, the start's workout with every set the notice holds, so the
// review offers them; the notice stays, and names the copy's reason. A notice of anything else, one holding no set, a
// workout deleted before the refusal, a copy already saved and a workout on the log save nothing.
/** @param {GymNotice} notice */
export function SaveRefusedStart(notice) {
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) {
      const workout = SignedOutWorkout.ofRefusedStart(notice);
      return { workout, backup: SignedOutWorkout.read(read),
        onLog: workout !== null && read.repository(Session).record(workout.session.id.record, 'stored') !== undefined };
    },
    /** @param {{ workout: SignedOutWorkout | null, backup: readonly SignedOutWorkout[], onLog: boolean }} loaded */
    decide({ workout, backup, onLog }) {
      if (workout === null || workout.sets.length === 0 || onLog || backup.some((copy) => copy.session.id.equals(workout.session.id))) {
        return Decision.unchanged(null);
      }
      const plan = new Plan();
      plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(backup, [workout]));
      return Decision.write(plan, null);
    },
  });
}

// Drops a saved copy the account has not taken, with every set it holds.
/** @param {SessionId} id */
export function DiscardSignedOutWorkout(id) {
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return SignedOutWorkout.read(read); },
    /** @param {readonly SignedOutWorkout[]} saved */
    decide(saved) {
      if (!saved.some((copy) => copy.session.id.equals(id))) return Decision.unchanged(null);
      const plan = new Plan();
      plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(saved, [], [id]));
      return Decision.write(plan, null);
    },
  });
}

// A set the account refused after its workout had landed lives only in its notice; the saved copy still holds it.
// `intoWorkout` puts the sets inside the workout's window back into it: appended while it is open, else corrected in,
// numbered after the ones it kept, its times left alone. `separately` makes the sets outside the window a saved copy of
// their own, from the first to the last, and queues its import, so a refusal of it is that copy's to fix. Either replays
// what the copy recorded and takes a revised copy, whose changed loads meet their floors and which replaces the saved one
// only when the retry is queued.
/**
 * @typedef {{ backup: readonly SignedOutWorkout[], workout: SignedOutWorkout | null, session: SessionValue | null,
 *   stranded: readonly TrainingSetValue[], state: TrainingState }} StrandedLoaded
 */
/** @param {SessionId} id @param {'intoWorkout' | 'separately'} placement @param {SignedOutWorkout | null} [revised] */
export function RecoverStrandedSets(id, placement, revised = null) {
  precondition(revised === null || revised.session.id.equals(id), 'a revision keeps the saved workout\'s identity');
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read @returns {StrandedLoaded} */
    load(read) {
      const state = new TrainingState(read);
      const backup = SignedOutWorkout.read(read);
      const saved = backup.find((copy) => copy.session.id.equals(id));
      const workout = saved === undefined ? null : revised ?? saved;
      const stranded = (workout?.sets ?? []).filter((set) => read.confirmed(TrainingSet, set.id) === null
        && !state.drawnSets.some((drawn) => drawn.id.equals(set.id)));
      return { backup, workout, session: read.repository(Session).find(id, 'stored'), stranded, state };
    },
    /** @param {StrandedLoaded} loaded @param {IDSource} ids */
    decide({ backup, workout, session, stranded, state }, ids) {
      if (workout === null || stranded.length === 0) return Decision.unchanged(null);
      if (session === null) return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-record', id.ref, null, 'predicted')));
      const floor = workout.floorRefusal(backup.find((copy) => copy.session.id.equals(id)) ?? null, state.catalogue);
      if (floor !== null) return Decision.refuse(floor);
      const { finishedAt } = session;
      const inside = stranded.filter((set) => set.completedAt.ms >= session.startedAt.ms && (finishedAt === null || set.completedAt.ms <= finishedAt.ms));
      if (placement === 'intoWorkout') {
        if (inside.length === 0) return Decision.unchanged(null);
        const placing = placed(id, inside, session, state, ids);
        if (placing.kind === 'refuse') return Decision.refuse(placing.refusal);
        if (placing.kind === 'unchanged') return Decision.unchanged(null);
        placing.plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(backup, [workout]));
        return Decision.write(placing.plan, null);
      }
      const outside = stranded.filter((set) => !inside.some((each) => each.id.equals(set.id)));
      const [first] = outside, last = outside.at(-1);
      if (first === undefined || last === undefined) return Decision.unchanged(null);
      const separate = new SessionValue(ids.mint(Session), first.completedAt, last.completedAt, 'finish');
      const copy = new SignedOutWorkout(separate, outside.map((set) => new TrainingSetValue(set.id, separate.id, set.exerciseId,
        set.weightKg, set.reps, set.completedAt, set.rpe, set.note)));
      const refused = copy.importRefusal(state.moment, state.stored, state.catalogue);
      if (refused !== null) return Decision.refuse(refused);
      const imported = decision(copy.importAction.recorded, { state, routine: null }, ids);
      if (imported.kind === 'refuse') return Decision.refuse(imported.refusal);
      if (imported.kind === 'unchanged') return Decision.unchanged(null);
      const kept = new SignedOutWorkout(workout.session, workout.sets.filter((set) => !outside.some((each) => each.id.equals(set.id))));
      imported.plan.device(SignedOutWorkout.key, SignedOutWorkout.saved(backup, [kept, copy]));
      return Decision.write(imported.plan, null);
    },
  });
}

// The sets back into their workout: appended in one plan while it is open, else one additive correction that numbers
// each after its movement's last, its times left alone.
/**
 * @param {SessionId} id @param {readonly TrainingSetValue[]} sets @param {SessionValue} session @param {TrainingState} state
 * @param {IDSource} ids
 * @returns {import('../../../platform/domain-kit/actions.js').Decision<null, GymRefusal>}
 */
function placed(id, sets, session, state, ids) {
  const { finishedAt } = session;
  if (finishedAt === null) {
    const plan = new Plan();
    /** @type {TrainingSetValue[]} */
    const planned = [];
    for (const set of sets) {
      const valid = new Valid(set, state.moment);
      const refused = AppendSet.refusal(valid, session, state, planned);
      if (refused !== null) return Decision.refuse(refused);
      plan.create(valid);
      planned.push(valid.value);
    }
    return Decision.write(plan, null);
  }
  /** @type {Map<string, number>} */
  const numbers = new Map();
  const corrected = sets.map((set) => {
    const movement = jcs(set.exerciseId.json);
    const next = numbers.get(movement) ?? SetRules.nextNumber(state.sets, id, set.exerciseId);
    if (next === null || next > SetRules.maxNumber) throw new Violation('set.setNumber', new Path('setNumber'), { kind: 'above', max: SetRules.maxNumber });
    numbers.set(movement, next + 1);
    return new CorrectedSet({ id: set.id, exerciseId: set.exerciseId, setNumber: next, weightKg: set.weightKg, reps: set.reps,
      completedAt: set.completedAt, rpe: set.rpe, note: set.note, rpeNamed: true });
  });
  const correction = CorrectSession({ id, requestId: ids.opaqueID(), startedAt: session.startedAt, finishedAt,
    routineName: session.displayName, sets: corrected, preserveOtherSets: true });
  return decision(correction.recorded, state, ids);
}
