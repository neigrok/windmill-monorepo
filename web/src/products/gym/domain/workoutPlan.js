// @ts-check

import { Decision } from '../../../platform/domain-kit/actions.js';
import { sameJson } from '../../../platform/domain-kit/entities.js';
import { Plan } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation, precondition } from '../../../platform/domain-kit/values.js';
import { Catalogue } from './catalogue.js';
import { GymRefusals, WorkoutPlanRules } from './gymRules.js';
import { RoutineChange } from './proposals.js';
import { PlanSnapshot, Routine, RoutineEntry, SetTarget } from './routines.js';
import { Session, SessionRules, TrainingSet } from './training.js';
import { Readout } from './trainingReads.js';

/** @typedef {import('../../../platform/domain-kit/entities.js').RecordRef} RecordRef */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/time.js').Moment} Moment */
/** @typedef {import('../../../platform/domain-kit/entities.js').Id<any>} AnyId */
/** @typedef {import('./catalogue.js').ExerciseValue} ExerciseValue */
/** @typedef {import('./training.js').SessionValue} SessionValue */
/** @typedef {import('./training.js').TrainingSetValue} TrainingSetValue */
/** @typedef {import('./routines.js').RoutineValue} RoutineValue */
/** @typedef {import('./gymRules.js').GymRefusal} GymRefusal */
/** @typedef {import('../../../platform/domain-kit/entities.js').Id<ExerciseValue>} ExerciseId */
/** @typedef {{ entry: RoutineEntry, written: boolean }} PlanLine */

// An open workout as an edit of its plan reads it: the session as stored and whether it is in sight, its sets as stored,
// the movements a set alive in either view locks (a set the lifter just deleted locks its movement until the delete
// lands), the movements the account can name, and the moment.
export class OpenWorkout {
  /**
   * @param {{ id: import('../../../platform/domain-kit/entities.js').Id<SessionValue>, session: SessionValue | null, visible: boolean,
   *   sets: readonly TrainingSetValue[], logged: readonly ExerciseId[], catalogue: Catalogue, moment: Moment }} parts
   */
  constructor({ id, session, visible, sets, logged, catalogue, moment }) {
    this.id = id;
    this.session = session;
    this.visible = visible;
    this.sets = Object.freeze([...sets]);
    this.logged = Object.freeze([...logged]);
    this.catalogue = catalogue;
    this.moment = moment;
    Object.freeze(this);
  }

  /** @param {Reader} read @param {import('../../../platform/domain-kit/entities.js').Id<SessionValue>} id */
  static of(read, id) {
    const sessions = read.repository(Session), sets = read.repository(TrainingSet);
    const stored = sets.all('stored').filter((set) => set.sessionId.equals(id));
    return new OpenWorkout({ id, session: sessions.find(id, 'stored'), visible: sessions.find(id, 'drawn') !== null, sets: stored,
      logged: [...sets.all('drawn').filter((set) => set.sessionId.equals(id)), ...stored].map((set) => set.exerciseId),
      catalogue: new Catalogue(read), moment: read.moment });
  }

  /** @param {ExerciseId} movement */
  isLogged(movement) { return this.logged.some((id) => id.equals(movement)); }

  // Closed by its finish, or by the stale rule four hours past its last stored set.
  get isClosed() {
    return this.session !== null && !SessionRules.drawn(this.session, this.sets, this.moment.now).isOpen;
  }

  // A workout out of sight is gone; a closed one is finished, said of the record the edit writes.
  /** @param {RecordRef} subject @returns {GymRefusal | null} */
  refusal(subject) {
    if (this.session === null || !this.visible) return GymRefusals.ofRefused(new Refused('unknown-record', this.id.ref, null, 'predicted'));
    if (this.isClosed) return GymRefusals.ofRefused(new Refused('session-finished', subject, null, 'predicted'));
    return null;
  }

  get plan() {
    const plan = this.session?.plan ?? null;
    if (plan === null) throw new Violation(WorkoutPlanRules.absent, new Path('plan'), { kind: 'custom', custom: 'absent' });
    return plan;
  }
}

// A movement with a logged set stands as the plan holds it; the refusal names it.
/** @param {ExerciseId} movement @param {RecordRef} subject */
export function loggedRefusal(movement, subject) {
  return GymRefusals.ofRefused(new Refused('plan-logged', subject, { exerciseId: movement.json }, 'predicted'));
}

// One edit of the plan. It names the entry it edits by `index`, a planned set of that entry by `set`, and the movement it
// brings into the plan by `movement`; the plan checks each name before the edit changes its lines.
/**
 * @typedef {{ index: number | null, set: number | null, movement: ExerciseId | null,
 *   changed: (lines: readonly PlanLine[], catalogue: Catalogue) => readonly PlanLine[] }} PlanOperation
 */

/** @param {readonly PlanLine[]} lines @param {number} index @param {(entry: RoutineEntry) => RoutineEntry} edit */
function rewriting(lines, index, edit) { return lines.map((line, at) => at === index ? { entry: edit(line.entry), written: true } : line); }

export const PlanOperations = Object.freeze({
  /** @param {number} index @param {number} set @param {SetTarget} target @returns {PlanOperation} */
  retarget: (index, set, target) => Object.freeze({ index, set, movement: null,
    changed: (lines) => rewriting(lines, index, (entry) => new RoutineEntry(entry.exerciseId,
      (entry.sets ?? []).map((planned, at) => at === set ? target : planned), entry.restSeconds)) }),
  /** @param {number} index @returns {PlanOperation} */
  addSet: (index) => Object.freeze({ index, set: null, movement: null,
    changed: (lines) => rewriting(lines, index, (entry) => new RoutineEntry(entry.exerciseId,
      [...entry.sets ?? [], entry.sets?.at(-1) ?? new SetTarget()], entry.restSeconds)) }),
  /** @param {number} index @param {number} set @returns {PlanOperation} */
  removeSet: (index, set) => Object.freeze({ index, set, movement: null,
    changed: (lines) => rewriting(lines, index, (entry) => {
      const sets = (entry.sets ?? []).filter((_, at) => at !== set);
      return new RoutineEntry(entry.exerciseId, sets.length === 0 ? null : sets, entry.restSeconds);
    }) }),
  // A movement in another's place keeps its planned sets and rest; its loads stand only where both read in the same unit.
  /** @param {number} index @param {ExerciseId} exerciseId @returns {PlanOperation} */
  swap: (index, exerciseId) => Object.freeze({ index, set: null, movement: exerciseId,
    changed: (lines, catalogue) => rewriting(lines, index, (entry) => {
      /** @param {ExerciseId} id */
      const unit = (id) => {
        const exercise = catalogue.find(id);
        return Readout.loadUnit(exercise?.equipment ?? null, exercise?.loadCount ?? 1);
      };
      return new RoutineEntry(exerciseId, unit(entry.exerciseId) === unit(exerciseId) ? entry.sets
        : entry.sets?.map((target) => new SetTarget(target.reps, null)) ?? null, entry.restSeconds);
    }) }),
  /** @param {ExerciseId} exerciseId @returns {PlanOperation} */
  addMovement: (exerciseId) => Object.freeze({ index: null, set: null, movement: exerciseId,
    changed: (lines) => [...lines, { entry: new RoutineEntry(exerciseId), written: true }] }),
  /** @param {number} index @returns {PlanOperation} */
  removeMovement: (index) => Object.freeze({ index, set: null, movement: null,
    changed: (lines) => lines.filter((_, at) => at !== index) }),
  /** @param {number} index @param {number | null} restSeconds @returns {PlanOperation} */
  setRest: (index, restSeconds) => Object.freeze({ index, set: null, movement: null,
    changed: (lines) => rewriting(lines, index, (entry) => new RoutineEntry(entry.exerciseId, entry.sets, restSeconds)) }),
});

// A workout's plan under the lifter's edits. A movement with a logged set stands as it is: no edit touches its entry and no
// edit brings it back in. Every entry an edit wrote then takes a routine entry's bounds; an entry no edit wrote stands as stored.
export class WorkoutPlan {
  /** @param {PlanSnapshot} plan @param {OpenWorkout} workout @param {RecordRef} subject */
  constructor(plan, workout, subject) {
    this.plan = plan;
    this.workout = workout;
    this.subject = subject;
    Object.freeze(this);
  }

  /** @param {readonly PlanOperation[]} operations @returns {{ kind: 'revised', plan: PlanSnapshot } | { kind: 'refused', refusal: GymRefusal }} */
  revised(operations) {
    /** @type {readonly PlanLine[]} */
    let lines = this.plan.entries.map((entry) => ({ entry, written: false }));
    for (const [k, operation] of operations.entries()) {
      const at = new Path('operations').plus(k);
      if (operation.index !== null) {
        const entry = lines[operation.index]?.entry;
        if (entry === undefined || (operation.set !== null && !(operation.set >= 0 && operation.set < (entry.sets ?? []).length))) {
          throw new Violation(WorkoutPlanRules.operation, at, { kind: 'custom', custom: 'outOfRange' });
        }
        if (this.workout.isLogged(entry.exerciseId)) return { kind: 'refused', refusal: loggedRefusal(entry.exerciseId, this.subject) };
      }
      const movement = operation.movement;
      if (movement !== null) {
        if (this.workout.catalogue.find(movement) === null) {
          return { kind: 'refused', refusal: GymRefusals.ofRefused(new Refused('unknown-exercise', this.subject, null, 'predicted')) };
        }
        if (lines.some((line) => line.entry.exerciseId.equals(movement))) {
          throw new Violation(WorkoutPlanRules.duplicate, at.plus('exerciseId'), { kind: 'custom', custom: 'duplicate' });
        }
        if (this.workout.isLogged(movement)) return { kind: 'refused', refusal: loggedRefusal(movement, this.subject) };
      }
      lines = operation.changed(lines, this.workout.catalogue);
    }
    const bounded = WorkoutPlanRules.entries.apply([...lines], new Path('plan.entries'),
      (line, path) => line.written ? { entry: line.entry.validated(path), written: true } : line);
    return { kind: 'revised', plan: new PlanSnapshot(this.plan.routine, bounded.map((line) => line.entry)) };
  }
}

// The lifter's edit of the open workout's plan: every operation in order, then one guarded write of the whole plan, or
// nothing when the plan stands. `base` is the plan the editor read; any other stored plan is stale.
/**
 * @param {{ sessionId: import('../../../platform/domain-kit/entities.js').Id<SessionValue>, base: PlanSnapshot | null,
 *   operations: readonly PlanOperation[] }} input
 */
export function ReviseWorkoutPlan({ sessionId, base, operations }) {
  const requested = Object.freeze([...operations]);
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return OpenWorkout.of(read, sessionId); },
    /** @param {OpenWorkout} loaded */
    decide(loaded) {
      const refused = loaded.refusal(sessionId.ref);
      if (refused !== null) return Decision.refuse(refused);
      const stored = loaded.plan;
      if (base === null || !sameJson(base.json, stored.json)) return Decision.refuse(GymRefusals.ofRefused(new Refused('stale', sessionId.ref, null, 'predicted')));
      const revision = new WorkoutPlan(stored, loaded, sessionId.ref).revised(requested);
      if (revision.kind === 'refused') return Decision.refuse(revision.refusal);
      if (sameJson(revision.plan.json, stored.json)) return Decision.unchanged(null);
      precondition(loaded.session !== null, 'a revised workout is stored');
      const plan = new Plan();
      plan.update(new Valid(loaded.session.with({ plan: revision.plan }), loaded.moment, ['plan']), { guarded: true });
      return Decision.write(plan, null);
    },
  });
}

// The receipt's card for a workout whose own plan changed, which only the server's planRevision proves: the plan as the
// workout leaves it against its routine as drawn, R118's count with no name term, and whether the routine still stands
// as the workout started from it. No card for an unstamped plan, a plan that matches, no routine or no plan.
export class PlanChanges {
  static none = new PlanChanges([], 0, 'none');

  /** @param {readonly RoutineChange[]} changes @param {number} changeCount @param {'save' | 'routineChanged' | 'none'} offer */
  constructor(changes, changeCount, offer) {
    this.changes = Object.freeze([...changes]);
    this.changeCount = changeCount;
    this.offer = offer;
    Object.freeze(this);
  }

  /** @param {Reader} read @param {import('../../../platform/domain-kit/entities.js').Id<SessionValue>} id */
  static of(read, id) {
    const session = read.repository(Session).find(id, 'drawn');
    return PlanChanges.between(session, session?.routineId ? read.repository(Routine).find(session.routineId, 'drawn') : null);
  }

  /** @param {SessionValue | null} session @param {RoutineValue | null} routine */
  static between(session, routine) {
    const plan = session?.plan ?? null;
    if (session === null || session.planRevision === null || plan === null || routine === null
      || sameJson(plan.entries.map((entry) => entry.json), routine.entries.map((entry) => entry.json))) return PlanChanges.none;
    const changes = RoutineChange.between(routine.entries, plan.entries);
    const offer = routine.revision === null || session.routineRevision === null ? 'none'
      : routine.revision === session.routineRevision ? 'save' : 'routineChanged';
    return new PlanChanges(changes, RoutineChange.count(routine.entries, changes), offer);
  }

  get json() { return { changes: this.changes.map((change) => change.json), changeCount: this.changeCount, offer: this.offer }; }
}
