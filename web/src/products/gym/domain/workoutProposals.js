// @ts-check

import { Decision } from '../../../platform/domain-kit/actions.js';
import { EntityType, Id, sameJson } from '../../../platform/domain-kit/entities.js';
import { Plan, Prediction } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Check, Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation, precondition } from '../../../platform/domain-kit/values.js';
import { GymRefusals, WorkoutPlanRules, WorkoutProposalRules } from './gymRules.js';
import { RoutineChange, validatedChanges } from './proposals.js';
import { PlanSnapshot } from './routines.js';
import { Session } from './training.js';
import { OpenWorkout, loggedRefusal } from './workoutPlan.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/time.js').Instant} Instant */
/** @typedef {import('../../../platform/domain-kit/time.js').Moment} Moment */
/** @typedef {import('./catalogue.js').ExerciseValue} ExerciseValue */
/** @typedef {import('./routines.js').RoutineEntry} RoutineEntry */
/** @typedef {import('./training.js').SessionValue} SessionValue */
/** @typedef {import('./gymRules.js').GymRefusal} GymRefusal */

export class WorkoutProposalValue {
  /**
   * @param {{ id: Id<WorkoutProposalValue>, sessionId: Id<SessionValue>, summary: string, changes: readonly RoutineChange[],
   *   door?: string, connection?: string, agent?: string, state?: string, supersededBy?: Id<WorkoutProposalValue> | null,
   *   settledAt?: Instant | null, baseRevision?: number | null, changeCount?: number | null, threadId?: string | null }} input
   */
  constructor({ id, sessionId, summary, changes, door = 'ask', connection = '', agent = '', state = 'pending', supersededBy = null,
    settledAt = null, baseRevision = null, changeCount = null, threadId = null }) {
    this.id = id;
    this.sessionId = sessionId;
    this.summary = summary;
    this.changes = Object.freeze([...changes]);
    this.door = door;
    this.connection = connection;
    this.agent = agent;
    this.state = state;
    this.supersededBy = supersededBy;
    this.settledAt = settledAt;
    this.baseRevision = baseRevision;
    this.changeCount = changeCount;
    this.threadId = threadId;
    Object.freeze(this);
  }

  fields() {
    return { sessionId: this.sessionId.json, summary: this.summary, changes: this.changes.map((change) => change.json),
      door: this.door, connection: this.connection, agent: this.agent };
  }

  get document() { return RoutineChange.document(this.changes); }
}

/** @type {EntityType<WorkoutProposalValue>} */
export const WorkoutProposal = new EntityType({
  type: 'workoutProposal', scope: 'self/gym',
  decode: (fields) => new WorkoutProposalValue({ id: new Id(fields.id, WorkoutProposal), sessionId: fields.ref('sessionId', Session),
    summary: fields.string('summary', ''), changes: fields.list('changes', RoutineChange.decode), door: fields.string('door', 'ask'),
    connection: fields.string('connection', ''), agent: fields.string('agent', ''), state: fields.string('state', 'pending'),
    supersededBy: fields.optionalRef('supersededBy', WorkoutProposal), settledAt: fields.optionalInstant('settledAt'),
    baseRevision: fields.optionalInt('baseRevision'), changeCount: fields.optionalInt('changeCount'), threadId: fields.optionalString('threadId') }),
  checks: [
    new Check('summary', (value) => new WorkoutProposalValue({ ...value, summary: WorkoutProposalRules.change.summary.apply(value.summary, new Path('summary')) })),
    new Check('changes', (value) => new WorkoutProposalValue({ ...value, changes: validatedChanges(WorkoutProposalRules.change, value.changes, new Path('changes')) })),
    new Check('door', (value) => new WorkoutProposalValue({ ...value, door: WorkoutProposalRules.change.door.apply(value.door, new Path('door')) })),
    new Check('connection', (value) => new WorkoutProposalValue({ ...value, connection: WorkoutProposalRules.change.connection.apply(value.connection, new Path('connection')) })),
    new Check('agent', (value) => new WorkoutProposalValue({ ...value, agent: WorkoutProposalRules.change.agent.apply(value.agent, new Path('agent')) })),
  ],
});

// The Coach's whole plan for the open workout, as a diff against the plan this device stores, guarding it. The proposal
// refuses what the log would: a movement it cannot name, a second entry of one, and a change to a movement with a logged
// set, which must stand in the proposal as it stands in the plan.
/**
 * @param {{ id: Id<WorkoutProposalValue>, sessionId: Id<SessionValue>, entries: readonly RoutineEntry[], summary: string }} input
 */
export function ProposeWorkout({ id, sessionId, entries, summary }) {
  const proposed = Object.freeze([...entries]);
  return Object.freeze({
    scope: WorkoutProposal.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return OpenWorkout.of(read, sessionId); },
    /** @param {OpenWorkout} loaded */
    decide(loaded) {
      const refused = loaded.refusal(id.ref);
      if (refused !== null) return Decision.refuse(refused);
      const stored = loaded.plan.entries;
      const proposal = new Valid(new WorkoutProposalValue({ id, sessionId, summary, changes: RoutineChange.between(stored, proposed) }), loaded.moment);
      if (proposed.some((entry) => loaded.catalogue.find(entry.exerciseId) === null)) {
        return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-exercise', id.ref, null, 'predicted')));
      }
      const second = proposed.findIndex((entry, at) => proposed.slice(0, at).some((before) => before.exerciseId.equals(entry.exerciseId)));
      if (second >= 0) throw new Violation(WorkoutPlanRules.duplicate, new Path('entries').plus(second).plus('exerciseId'), { kind: 'custom', custom: 'duplicate' });
      /** @param {readonly RoutineEntry[]} side @param {Id<ExerciseValue>} movement */
      const entryOf = (side, movement) => side.find((entry) => entry.exerciseId.equals(movement))?.json ?? null;
      const changed = [...stored, ...proposed].map((entry) => entry.exerciseId)
        .find((movement) => loaded.isLogged(movement) && !sameJson(entryOf(stored, movement), entryOf(proposed, movement)));
      if (changed !== undefined) return Decision.refuse(loggedRefusal(changed, id.ref));
      RoutineChange.floored(proposal.value.changes, loaded.catalogue, new Path('changes'));
      if (sameJson(stored.map((entry) => entry.json), proposed.map((entry) => entry.json))) return Decision.unchanged(id);
      const plan = new Plan();
      plan.create(proposal);
      plan.guardRead(sessionId, ['plan']);
      return Decision.write(plan, id);
    },
  });
}

// A workout proposal with its workout as this device stores it. Out of date, it can no longer be applied, by the first
// that holds: a newer proposal replaced it, its workout closed, the plan changed since it was made, or a movement it
// changes was logged since.
export class WorkoutProposalState {
  /** @param {{ proposal: WorkoutProposalValue | null, workout: OpenWorkout | null, moment: Moment }} parts */
  constructor({ proposal, workout, moment }) {
    this.proposal = proposal;
    this.workout = workout;
    this.moment = moment;
    Object.freeze(this);
  }

  /** @param {Reader} read @param {Id<WorkoutProposalValue>} id */
  static of(read, id) {
    const proposal = read.repository(WorkoutProposal).find(id, 'stored');
    return new WorkoutProposalState({ proposal, workout: proposal === null ? null : OpenWorkout.of(read, proposal.sessionId), moment: read.moment });
  }

  /** @returns {{ reason: string, exerciseId?: Json } | null} */
  get outOfDate() {
    const proposal = this.proposal;
    if (proposal === null) return null;
    if (proposal.state === 'superseded') return { reason: proposal.supersededBy !== null ? 'replaced' : 'workout-changed' };
    const workout = this.workout;
    const session = workout?.session ?? null;
    if (proposal.state !== 'pending' || workout === null || session === null) return null;
    if (workout.isClosed) return { reason: 'workout-finished' };
    if (proposal.baseRevision !== null && (session.planRevision ?? 1) !== proposal.baseRevision) return { reason: 'workout-changed' };
    // A plan edit this device has not had confirmed moves no revision yet, so the stored plan itself must still be the
    // plan the proposal diffs, its kept lines included.
    if (session.plan !== null
      && !sameJson(RoutineChange.between(session.plan.entries, proposal.document).map((change) => change.json), proposal.changes.map((change) => change.json))) {
      return { reason: 'workout-changed' };
    }
    const moved = proposal.changes.find((change) => change.kind !== 'kept' && workout.isLogged(change.exerciseId));
    return moved === undefined ? null : { reason: 'workout-moved', exerciseId: moved.exerciseId.json };
  }

  // What the log would answer the decision, said before it is sent. Applying asks more than turning down: the workout must be
  // in sight and the proposal current.
  /** @param {Id<WorkoutProposalValue>} id @param {boolean} applying @returns {GymRefusal | null} */
  refusal(id, applying) {
    const proposal = this.proposal;
    if (proposal === null) return GymRefusals.ofRefused(new Refused('unknown-record', id.ref, null, 'predicted'));
    if (proposal.state === 'pending') {
      if (!applying) return null;
      if (this.workout?.session == null || !this.workout.visible) return GymRefusals.ofRefused(new Refused('unknown-record', proposal.sessionId.ref, null, 'predicted'));
    } else if (proposal.state === (applying ? 'applied' : 'dismissed')) {
      return null;
    } else if (proposal.state !== 'superseded') {
      return GymRefusals.ofRefused(new Refused('proposal-settled', id.ref, { state: proposal.state }, 'predicted'));
    }
    const outOfDate = this.outOfDate;
    return outOfDate === null ? null : GymRefusals.ofRefused(new Refused('proposal-superseded', id.ref, { reason: outOfDate.reason }, 'predicted'));
  }
}

/** @param {Id<WorkoutProposalValue>} id */
export function ApplyWorkoutProposal(id) {
  return Object.freeze({
    scope: WorkoutProposal.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return WorkoutProposalState.of(read, id); },
    /** @param {WorkoutProposalState} loaded */
    decide(loaded) {
      const refused = loaded.refusal(id, true);
      if (refused !== null) return Decision.refuse(refused);
      const proposal = loaded.proposal;
      precondition(proposal !== null && loaded.workout !== null, 'an applicable workout proposal exists with its workout');
      if (proposal.state === 'applied') return Decision.unchanged(null);
      RoutineChange.floored(proposal.changes, loaded.workout.catalogue, new Path('changes'));
      const command = { name: 'gym.applyWorkoutProposal', args: { proposalId: id.json }, specs: [] };
      const settled = Prediction.update(id, { state: 'applied', settledAt: loaded.moment.now.ms });
      const plan = Prediction.update(proposal.sessionId, { plan: new PlanSnapshot(loaded.workout.plan.routine, proposal.document).json });
      return Decision.write(Plan.running(command, [settled, plan]), null);
    },
  });
}

/** @param {Id<WorkoutProposalValue>} id */
export function DismissWorkoutProposal(id) {
  return Object.freeze({
    scope: WorkoutProposal.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return WorkoutProposalState.of(read, id); },
    /** @param {WorkoutProposalState} loaded */
    decide(loaded) {
      const refused = loaded.refusal(id, false);
      if (refused !== null) return Decision.refuse(refused);
      precondition(loaded.proposal !== null, 'a dismissible workout proposal exists');
      if (loaded.proposal.state === 'dismissed') return Decision.unchanged(null);
      const command = { name: 'gym.dismissWorkoutProposal', args: { proposalId: id.json }, specs: [] };
      return Decision.write(Plan.running(command, [Prediction.update(id, { state: 'dismissed', settledAt: loaded.moment.now.ms })]), null);
    },
  });
}
