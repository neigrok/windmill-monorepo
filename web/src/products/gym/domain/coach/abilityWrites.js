// @ts-check
// The abilities Coach writes with on the replica (INV-1), each composing the gesture's own decider under the id the turn
// gave the call (gym Coach G-7). A replay finds its record stored and answers as the first call did, creating nothing.

import { Decision, decision } from '../../../../platform/domain-kit/actions.js';
import { Id, sameJson } from '../../../../platform/domain-kit/entities.js';
import { Plan } from '../../../../platform/domain-kit/plans.js';
import { Refused } from '../../../../platform/domain-kit/refusals.js';
import { Valid } from '../../../../platform/domain-kit/validation.js';
import { Path, Violation } from '../../../../platform/domain-kit/values.js';
import { Catalogue, CreateExercise, Exercise } from '../catalogue.js';
import { GymRefusals, ProposalRules, WorkoutProposalRules } from '../gymRules.js';
import { Note, SaveNoteCall } from '../notes.js';
import { Proposal, RoutineCreation } from '../proposals.js';
import { Routine, SetTarget } from '../routines.js';
import { exerciseDocument } from '../trainingHistory.js';
import { TrainingLog } from '../trainingReads.js';
import { WorkoutProposal } from '../workoutProposals.js';
import { AbilityAnswer, CoachDocuments } from './abilityReads.js';

/** @typedef {import('../../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../../platform/domain-kit/actions.js').IDSource} IDSource */
/** @typedef {import('../catalogue.js').ExerciseValue} ExerciseValue */
/** @typedef {import('../routines.js').RoutineValue} RoutineValue */
/** @typedef {import('../notes.js').NoteValue} NoteValue */
/** @typedef {ReturnType<typeof import('../proposals.js').ProposeRoutine>} ProposeRoutineAction */
/** @typedef {ReturnType<typeof import('../workoutProposals.js').ProposeWorkout>} ProposeWorkoutAction */

/** @param {string} code @param {Id<any>} id */
function predicted(code, id) { return GymRefusals.ofRefused(new Refused(code, id.ref, null, 'predicted')); }

// `create_exercise`: a movement lands in the catalogue; one already there under the call's id is its replay.
export class CreateExerciseCall {
  scope = Exercise.scope;
  refusals = GymRefusals;

  /** @param {ExerciseValue} exercise */
  constructor(exercise) {
    this.exercise = exercise;
    this.creating = new CreateExercise(exercise);
  }

  /** @param {Reader} read */
  load(read) { return { stored: read.repository(Exercise).find(this.exercise.id, 'stored'), moment: read.moment }; }

  /** @param {ReturnType<CreateExerciseCall['load']>} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    if (loaded.stored !== null) return Decision.unchanged(new AbilityAnswer(exerciseDocument(loaded.stored)));
    const printed = exerciseDocument(new Valid(this.exercise, loaded.moment).value);
    const created = decision(this.creating, loaded.moment, ids);
    if (created.kind === 'refuse') return created;
    if (created.kind === 'unchanged') return Decision.unchanged(new AbilityAnswer(printed));
    return Decision.write(created.plan, new AbilityAnswer(printed, undefined, [this.exercise.id.ref]));
  }
}

// `create_routine`: a new day of the program lands as the lifter's editor would save it. A routine already standing
// under the call's id replays when it holds this document in its stored form, composed and trimmed, and refuses another.
export class CreateRoutineCall {
  scope = Routine.scope;
  refusals = GymRefusals;

  /** @param {RoutineValue} routine */
  constructor(routine) { this.routine = routine; }

  /** @param {Reader} read */
  load(read) {
    return { stored: read.repository(Routine).find(this.routine.id, 'stored'),
      creation: read.repository(RoutineCreation).find(new Id(this.routine.id.record, RoutineCreation), 'stored'), catalogue: new Catalogue(read), moment: read.moment };
  }

  /** @param {ReturnType<CreateRoutineCall['load']>} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    if (loaded.creation?.snapshot) return Decision.unchanged(new AbilityAnswer(loaded.creation.snapshot));
    const valid = new Valid(this.routine, loaded.moment);
    if (loaded.stored !== null) {
      if (!sameJson(loaded.stored.fields(), valid.value.fields())) return Decision.refuse(predicted('id-taken', this.routine.id));
      return Decision.unchanged(new AbilityAnswer(CoachDocuments.routine(loaded.stored)));
    }
    if (valid.value.entries.some((entry) => loaded.catalogue.find(entry.exerciseId) === null)) return Decision.refuse(predicted('unknown-exercise', this.routine.id));
    valid.value.entries.forEach((entry, index) => {
      const movement = loaded.catalogue.find(entry.exerciseId);
      if (movement !== null) SetTarget.floored(entry.sets ?? [], movement, new Path('entries').plus(index).plus('sets'));
    });
    const plan = new Plan();
    plan.create(valid);
    return Decision.write(plan, new AbilityAnswer(CoachDocuments.routine(valid.value), undefined, [this.routine.id.ref]));
  }
}

// `save_note`: Coach's note goes below every stored note; a duplicate or a replay answers the note that stands.
export class SaveNoteAbility {
  scope = Note.scope;
  refusals = GymRefusals;

  /** @param {NoteValue} note */
  constructor(note) {
    this.note = note;
    this.saving = new SaveNoteCall(note);
  }

  /** @param {Reader} read */
  load(read) { return { saving: this.saving.load(read), moment: read.moment }; }

  /** @param {ReturnType<SaveNoteAbility['load']>} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    const saved = decision(this.saving, loaded.saving, ids);
    if (saved.kind === 'refuse') return saved;
    const stored = loaded.saving.stored;
    /** @param {NoteValue} value @param {number} position */
    const answer = (value, position) => ({ saved: true, note: CoachDocuments.note(value, position) });
    if (saved.kind === 'unchanged') {
      const position = stored.findIndex((note) => note.id.equals(saved.result));
      const standing = stored[position];
      if (standing === undefined) return Decision.refuse(predicted('unknown-record', saved.result));
      return Decision.unchanged(new AbilityAnswer(answer(standing, position)));
    }
    return Decision.write(saved.plan, new AbilityAnswer(answer(new Valid(this.note, loaded.moment).value, stored.length), undefined, [saved.result.ref]));
  }
}

// `propose_routine_change` and `propose_routine_removal`: a proposal is minted under the call's id and the lifter
// decides; a proposal already standing under that id is its replay, whatever it holds.
export class ProposeRoutineCall {
  scope = Proposal.scope;
  refusals = GymRefusals;

  /** @param {ProposeRoutineAction} proposing @param {string} appBaseUrl */
  constructor(proposing, appBaseUrl) {
    this.proposing = proposing;
    this.appBaseUrl = appBaseUrl;
  }

  /** @param {Reader} read */
  load(read) {
    const log = new TrainingLog(read);
    const workouts = new Set(log.sessions.map((session) => String(session.id.record)));
    return { stored: read.repository(Proposal).find(this.proposing.id, 'stored'), proposing: this.proposing.load(read),
      sets: log.sets.filter((set) => workouts.has(String(set.sessionId.record))) };
  }

  /** @param {ReturnType<ProposeRoutineCall['load']>} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    /** @param {import('../proposals.js').ProposalValue} proposal */
    const receipt = (proposal) => CoachDocuments.proposal(proposal, loaded.proposing.routine,
      (exercise) => loaded.sets.filter((set) => set.exerciseId.equals(exercise)).length, this.appBaseUrl);
    if (loaded.stored !== null) return Decision.unchanged(new AbilityAnswer(receipt(loaded.stored)));
    const proposed = this.proposing.proposed(loaded.proposing);
    if (proposed.kind === 'refuse') return Decision.refuse(proposed.refusal);
    if (proposed.kind === 'unchanged') throw new Violation(ProposalRules.change.changes.path, new Path('entries'), { kind: 'custom', custom: 'noChange' });
    return Decision.write(proposed.plan, new AbilityAnswer(receipt(proposed.proposal.value), undefined, [this.proposing.id.ref]));
  }
}

// `propose_workout_change`: a workout proposal is minted under the call's id and the lifter decides on the workout's
// card; a proposal already standing under that id is its replay, whatever it holds.
export class ProposeWorkoutCall {
  scope = WorkoutProposal.scope;
  refusals = GymRefusals;

  /** @param {ProposeWorkoutAction} proposing */
  constructor(proposing) { this.proposing = proposing; }

  /** @param {Reader} read */
  load(read) { return { stored: read.repository(WorkoutProposal).find(this.proposing.id, 'stored'), workout: this.proposing.load(read) }; }

  /** @param {ReturnType<ProposeWorkoutCall['load']>} loaded @param {IDSource} ids */
  decide(loaded, ids) {
    const session = loaded.workout.session;
    /** @param {import('../workoutProposals.js').WorkoutProposalValue} proposal */
    const receipt = (proposal) => CoachDocuments.workoutProposal(proposal, session?.plan?.entries ?? [], session?.planRevision ?? null);
    if (loaded.stored !== null) return Decision.unchanged(new AbilityAnswer(receipt(loaded.stored)));
    const proposed = this.proposing.proposed(loaded.workout);
    if (proposed.kind === 'refuse') return Decision.refuse(proposed.refusal);
    if (proposed.kind === 'unchanged') throw new Violation(WorkoutProposalRules.change.changes.path, new Path('entries'), { kind: 'custom', custom: 'noChange' });
    return Decision.write(proposed.plan, new AbilityAnswer(receipt(proposed.proposal.value), undefined, [this.proposing.id.ref]));
  }
}

