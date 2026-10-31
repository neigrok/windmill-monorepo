// @ts-check

import { Rule, RuleBook } from '../../../platform/domain-kit/rules.js';
import { ChoiceSpec, CountSpec, NumberSpec, TextSpec, Violation } from '../../../platform/domain-kit/values.js';
import { registry } from '../../../platform/sync/schema.js';
import { WeighIn, WeighInRules } from './bodyweight.js';
import { Preferences, PreferencesRules } from './preferences.js';
import { Note, NoteRules } from './notes.js';
import { Exercise, ExerciseName } from './catalogue.js';
import { Routine } from './routines.js';
import { Proposal } from './proposals.js';
import { Session, SetRules, TrainingSet } from './training.js';
import { WorkoutProposal } from './workoutProposals.js';
export { Session, SessionRules, SetRules, TrainingSet } from './training.js';
export { Exercise, ExerciseName } from './catalogue.js';
export { Routine } from './routines.js';
export { Proposal } from './proposals.js';
export { WorkoutProposal } from './workoutProposals.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/entities.js').RecordRef} RecordRef */
/** @typedef {import('../../../platform/domain-kit/refusals.js').Refused} Refused */
/** @typedef {import('../../../platform/domain-kit/refusals.js').RefusalPath} RefusalPath */
/** @typedef {TextSpec | NumberSpec | ChoiceSpec | CountSpec} GymSpec */
/**
 * @typedef {{ kind: 'invalid', violation: Violation }
 * | { kind: 'stale' | 'gone' | 'taken' | 'future', subject: RecordRef, path: RefusalPath }
 * | { kind: 'full', type: string, cap: number, path: RefusalPath }
 * | { kind: 'sessionFinished' | 'sessionOpen' | 'sessionOverlap' | 'payloadConflict' | 'unknownExercise'
 *   | 'badInstant' | 'proposalSettled' | 'proposalSuperseded' | 'planLogged' | 'other', refused: Refused }} GymRefusal
 */

/** @type {import('../../../platform/domain-kit/refusals.js').Refusals<GymRefusal>} */
export const GymRefusals = Object.freeze({
  ofViolation: (violation) => Object.freeze({ kind: 'invalid', violation }),
  ofRefused: (refused) => {
    const { code, subject, path } = refused;
    if (subject !== null) {
      if (code === 'stale') return Object.freeze({ kind: 'stale', subject, path });
      if (code === 'unknown-record' || code === 'record-dead') return Object.freeze({ kind: 'gone', subject, path });
      if (code === 'id-taken' || code === 'id-spent') return Object.freeze({ kind: 'taken', subject, path });
      if (code === 'bad-instant' && subject.t === 'weighin') return Object.freeze({ kind: 'future', subject, path });
    }
    if (refused.cap !== null) return Object.freeze({ kind: 'full', ...refused.cap, path });
    switch (code) {
      case 'bad-instant': return Object.freeze({ kind: 'badInstant', refused });
      case 'session-finished': return Object.freeze({ kind: 'sessionFinished', refused });
      case 'session-open': return Object.freeze({ kind: 'sessionOpen', refused });
      case 'session-overlap': return Object.freeze({ kind: 'sessionOverlap', refused });
      case 'payload-conflict': return Object.freeze({ kind: 'payloadConflict', refused });
      case 'unknown-exercise': return Object.freeze({ kind: 'unknownExercise', refused });
      case 'proposal-settled': return Object.freeze({ kind: 'proposalSettled', refused });
      case 'proposal-superseded': return Object.freeze({ kind: 'proposalSuperseded', refused });
      case 'plan-logged': return Object.freeze({ kind: 'planLogged', refused });
      default: return Object.freeze({ kind: 'other', refused });
    }
  },
  isGeneric: (refusal) => refusal.kind === 'other',
});

/**
 * @param {GymRefusal} refusal
 * @returns {Json}
 */
export function refusalForm(refusal) {
  if (refusal.kind === 'invalid') return { invalid: refusal.violation.json };
  if (refusal.kind === 'full') return { full: { type: refusal.type, cap: refusal.cap, path: refusal.path } };
  if ('subject' in refusal) return { [refusal.kind]: { subject: refusal.subject, path: refusal.path } };
  const { code, subject, detail, path } = refusal.refused;
  return { [refusal.kind]: { code, subject, detail, path } };
}

export const ExerciseRules = Object.freeze({
  name: new TextSpec('exercise.name', { unit: 'chars', min: 1, max: 60, trim: true, nfc: true }),
  seedName: new TextSpec('exerciseName.name', { unit: 'chars', min: 1, max: 60, trim: true, nfc: true }),
  pattern: new ChoiceSpec('exercise.pattern', ['squat', 'hinge', 'press', 'pull', 'carry', 'core', 'isolation']),
  equipment: new ChoiceSpec('exercise.equipment', ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'other']),
  equipmentOverride: new ChoiceSpec('exerciseName.equipment', ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'other']),
  loadCount: new NumberSpec('exerciseName.loadCount', { min: 1, max: 2, integer: true }),
  stepKg: new NumberSpec('exercise.stepKg', { min: 0.01, max: 99.99, quantum: 0.01 }),
});

/** @param {string} path */
function targetSpecs(path) {
  return Object.freeze({
    sets: new CountSpec(`${path}.sets`, { min: 1, max: 20 }),
    reps: new NumberSpec(`${path}.sets.reps`, { min: 1, max: 100, integer: true }),
    weight: new NumberSpec(`${path}.sets.weightKg`, { quantum: 0.01 }),
    rest: new NumberSpec(`${path}.restSeconds`, { min: 15, max: 900, integer: true }),
  });
}

export const RoutineRules = Object.freeze({
  name: new TextSpec('routine.name', { unit: 'chars', min: 1, max: 60, trim: true, nfc: true }),
  position: new NumberSpec('routine.position', { min: 0, max: 2_147_483_647, integer: true }),
  entries: new CountSpec('routine.entries', { min: 1, max: 50 }),
  exercise: new TextSpec('routine.entries.exerciseId', { unit: 'chars', min: 1, max: 64, trim: false, nfc: false }),
  targets: targetSpecs('routine.entries'),
  loadFloor: 'routine.loadFloor',
});

// The rules every proposal's change lines obey, each proposal type under its own paths: a routine's at `proposal.*`, a
// workout's at `workoutProposal.*`.
/** @param {string} type */
function changeRules(type) {
  return Object.freeze({
    summary: new TextSpec(`${type}.summary`, { unit: 'bytes', min: 0, max: 400, trim: true, nfc: true }),
    changes: new CountSpec(`${type}.changes`, { min: 0, max: 100 }),
    kind: new ChoiceSpec(`${type}.changes.kind`, ['kept', 'added', 'removed', 'retargeted']),
    exercise: new TextSpec(`${type}.changes.exerciseId`, { unit: 'chars', min: 1, max: 64, trim: false, nfc: false }),
    door: new ChoiceSpec(`${type}.door`, ['ask']),
    connection: new TextSpec(`${type}.connection`, { unit: 'bytes', min: 0, max: 0, trim: false, nfc: false }),
    agent: new TextSpec(`${type}.agent`, { unit: 'chars', min: 0, max: 0, trim: false, nfc: false }),
    before: targetSpecs(`${type}.changes.before`),
    after: targetSpecs(`${type}.changes.after`),
    zeroTarget: `${type}.zeroTarget`,
  });
}

/** @typedef {ReturnType<typeof targetSpecs>} TargetSpecs */
/** @typedef {ReturnType<typeof changeRules>} ChangeRules */

export const ProposalRules = Object.freeze({
  intent: new ChoiceSpec('proposal.intent', ['revise', 'remove']),
  name: new TextSpec('proposal.proposedName', { unit: 'bytes', min: 0, max: 240, trim: true, nfc: true }),
  change: changeRules('proposal'),
});

export const WorkoutProposalRules = Object.freeze({ change: changeRules('workoutProposal') });

export const WorkoutPlanRules = Object.freeze({
  entries: new CountSpec('session.plan.entries', { min: 0, max: 50 }),
  absent: 'session.plan.absent',
  duplicate: 'session.plan.duplicate',
  operation: 'session.plan.operation',
});

export const CommandSpecs = Object.freeze([
  new TextSpec('gym.correctSession.requestId', { unit: 'chars', min: 8, max: 64, trim: false, nfc: false }),
  new TextSpec('gym.correctSession.routineName', { unit: 'bytes', min: 0, max: 240, trim: false, nfc: false }),
  ...['gym.correctSession', 'gym.importSession'].flatMap((command) => [
    new TextSpec(`${command}.sets.exerciseId`, { unit: 'chars', min: 1, max: 64, trim: false, nfc: false }),
    new TextSpec(`${command}.sets.id`, { unit: 'chars', min: 8, max: 64, trim: false, nfc: false }),
    new TextSpec(`${command}.sets.note`, { unit: 'bytes', min: 0, max: 4000, trim: false, nfc: false }),
  ]),
]);

/** @type {RuleBook | null} */
let book = null;

export const GymRules = Object.freeze({
  get specs() {
    const { targets, loadFloor, ...routine } = RoutineRules;
    /** @param {ChangeRules} rules */
    const changeSpecs = ({ before, after, zeroTarget, ...change }) => [...Object.values(change), ...Object.values(before), ...Object.values(after)];
    return Object.freeze([...Object.values(NoteRules), WeighInRules.kg, PreferencesRules.units,
      ...Object.values(ExerciseRules), ...Object.values(routine), ...Object.values(targets),
      ProposalRules.intent, ProposalRules.name, ...changeSpecs(ProposalRules.change), ...changeSpecs(WorkoutProposalRules.change),
      WorkoutPlanRules.entries, SetRules.weightKg, SetRules.reps, SetRules.rpe, SetRules.note, ...CommandSpecs]);
  },
  /** @param {string} path */
  spec(path) { return GymRules.specs.find((spec) => spec.path === path) ?? null; },
  get book() {
    if (book !== null) return book;
    book = new RuleBook(registry, [Note, WeighIn, Preferences, Exercise, ExerciseName, Routine, Session, TrainingSet, Proposal, WorkoutProposal], [
      ...GymRules.specs.map((spec) => Rule.localSpec(spec)),
      Rule.localCheck(WeighInRules.day, 'weighin', ['bad-instant']),
      Rule.localCheck('coach.import', 'routine'),
      ...['routine.order', 'routine.zeroTarget', RoutineRules.loadFloor, ProposalRules.change.zeroTarget, WorkoutProposalRules.change.zeroTarget, 'set.completedAt', 'set.identity', SetRules.loadFloor,
        'set.setNumber', 'session.startedAt', 'session.finishedAt', 'session.sets', 'session.requestId', WorkoutPlanRules.absent,
        WorkoutPlanRules.duplicate, WorkoutPlanRules.operation]
        .map((name) => Rule.localCheck(name, name.split('.')[0] ?? name)),
      Rule.serverDecided('routine.exercise', ['unknown-exercise'], 'routine'),
      Rule.serverDecided('proposal.exercise', ['unknown-exercise'], 'proposal'),
      Rule.serverDecided('set.session', ['session-finished'], 'set'),
      Rule.serverDecided('set.exercise', ['unknown-exercise'], 'set'),
      Rule.serverDecided('session.open', ['session-open'], 'session'),
      Rule.serverDecided('session.instant', ['bad-instant'], 'session'),
      Rule.serverDecided('session.overlap', ['session-overlap'], 'session'),
      Rule.serverDecided('session.payload', ['payload-conflict'], 'session'),
      Rule.serverDecided('proposal.settled', ['proposal-settled'], 'proposal'),
      Rule.serverDecided('proposal.superseded', ['proposal-superseded'], 'proposal'),
      Rule.serverDecided('session.plan.exercise', ['unknown-exercise'], 'session'),
      Rule.serverDecided('session.plan.logged', ['plan-logged'], 'session'),
      Rule.serverDecided('session.finished', ['session-finished'], 'session'),
      Rule.serverDecided('session.stale', ['stale'], 'session'),
      Rule.serverDecided('workoutProposal.exercise', ['unknown-exercise'], 'workoutProposal'),
      Rule.serverDecided('workoutProposal.plan', ['plan-logged'], 'workoutProposal'),
      Rule.serverDecided('workoutProposal.session', ['session-finished'], 'workoutProposal'),
      Rule.serverDecided('workoutProposal.settled', ['proposal-settled'], 'workoutProposal'),
      Rule.serverDecided('workoutProposal.superseded', ['proposal-superseded'], 'workoutProposal'),
    ]);
    return book;
  },
});
