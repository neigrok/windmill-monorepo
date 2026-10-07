// @ts-check

import { EntityType, Fields, Id } from '../../../platform/domain-kit/entities.js';
import { Rule, RuleBook } from '../../../platform/domain-kit/rules.js';
import { Check } from '../../../platform/domain-kit/validation.js';
import { ChoiceSpec, CountSpec, NumberSpec, Path, TextSpec, Violation } from '../../../platform/domain-kit/values.js';
import { registry } from '../../../platform/sync/schema.js';
import { WeighIn, WeighInRules } from './bodyweight.js';
import { Preferences, PreferencesRules } from './preferences.js';
import { Exercise, ExerciseName } from './catalogue.js';
import { Routine } from './routines.js';
export { Exercise, ExerciseName } from './catalogue.js';
export { Routine } from './routines.js';

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
 *   | 'badInstant' | 'proposalSettled' | 'proposalSuperseded' | 'other', refused: Refused }} GymRefusal
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

export const NoteRules = Object.freeze({
  title: new TextSpec('note.title', { unit: 'chars', min: 1, max: 60, trim: true, nfc: true }),
  body: new TextSpec('note.body', { unit: 'bytes', min: 0, max: 500, trim: true, nfc: true }),
});

export const ExerciseRules = Object.freeze({
  name: new TextSpec('exercise.name', { unit: 'chars', min: 1, max: 60, trim: true, nfc: true }),
  seedName: new TextSpec('exerciseName.name', { unit: 'chars', min: 1, max: 60, trim: true, nfc: true }),
  pattern: new ChoiceSpec('exercise.pattern', ['squat', 'hinge', 'press', 'pull', 'carry', 'core', 'isolation']),
  equipment: new ChoiceSpec('exercise.equipment', ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell']),
  stepKg: new NumberSpec('exercise.stepKg', { min: 0.01, max: 99.99, quantum: 0.01 }),
});

/** @param {string} path */
function targetSpecs(path) {
  return Object.freeze({
    sets: new CountSpec(`${path}.sets`, { min: 1, max: 20 }),
    reps: new NumberSpec(`${path}.sets.reps`, { min: 1, max: 100, integer: true }),
    weight: new NumberSpec(`${path}.sets.weightKg`, { min: -500, max: 500, quantum: 0.01 }),
    rest: new NumberSpec(`${path}.restSeconds`, { min: 15, max: 900, integer: true }),
  });
}

export const RoutineRules = Object.freeze({
  name: new TextSpec('routine.name', { unit: 'chars', min: 1, max: 60, trim: true, nfc: true }),
  position: new NumberSpec('routine.position', { min: 0, max: 2_147_483_647, integer: true }),
  entries: new CountSpec('routine.entries', { min: 1, max: 50 }),
  exercise: new TextSpec('routine.entries.exerciseId', { unit: 'chars', min: 1, max: 64, trim: false, nfc: false }),
  targets: targetSpecs('routine.entries'),
});

export const ProposalRules = Object.freeze({
  intent: new ChoiceSpec('proposal.intent', ['revise', 'remove']),
  name: new TextSpec('proposal.proposedName', { unit: 'bytes', min: 0, max: 240, trim: true, nfc: true }),
  summary: new TextSpec('proposal.summary', { unit: 'bytes', min: 0, max: 400, trim: true, nfc: true }),
  changes: new CountSpec('proposal.changes', { min: 0, max: 100 }),
  kind: new ChoiceSpec('proposal.changes.kind', ['kept', 'added', 'removed', 'retargeted']),
  exercise: new TextSpec('proposal.changes.exerciseId', { unit: 'chars', min: 1, max: 64, trim: false, nfc: false }),
  door: new ChoiceSpec('proposal.door', ['ask']),
  connection: new TextSpec('proposal.connection', { unit: 'bytes', min: 0, max: 0, trim: false, nfc: false }),
  agent: new TextSpec('proposal.agent', { unit: 'chars', min: 0, max: 0, trim: false, nfc: false }),
  before: targetSpecs('proposal.changes.before'),
  after: targetSpecs('proposal.changes.after'),
});

export const SetRules = Object.freeze({
  weightKg: new NumberSpec('set.weightKg', { min: -500, max: 500, quantum: 0.01 }),
  reps: new NumberSpec('set.reps', { min: 1, max: 500, integer: true }),
  kind: new ChoiceSpec('set.kind', ['warmup', 'working', 'drop', 'failure']),
  rpe: new NumberSpec('set.rpe', { min: 1, max: 10, quantum: 0.1 }),
  note: new TextSpec('set.note', { unit: 'bytes', min: 0, max: 4000, trim: false, nfc: false }),
});

export const SessionRules = Object.freeze({
  maxInstantMs: 253_402_300_799_000,
  /**
   * @param {number} value
   * @param {string} rule
   * @param {Path} path
   */
  instant(value, rule, path) {
    if (value < 1) throw new Violation(rule, path, { kind: 'below', min: 1 });
    if (value > SessionRules.maxInstantMs) throw new Violation(rule, path, { kind: 'above', max: SessionRules.maxInstantMs });
    return value;
  },
});

export const CommandSpecs = Object.freeze([
  new TextSpec('gym.correctSession.requestId', { unit: 'chars', min: 8, max: 64, trim: false, nfc: false }),
  new TextSpec('gym.correctSession.routineName', { unit: 'bytes', min: 0, max: 240, trim: false, nfc: false }),
  ...['gym.correctSession', 'gym.importSession'].flatMap((command) => [
    new TextSpec(`${command}.sets.exerciseId`, { unit: 'chars', min: 1, max: 64, trim: false, nfc: false }),
    new TextSpec(`${command}.sets.id`, { unit: 'chars', min: 8, max: 64, trim: false, nfc: false }),
    new TextSpec(`${command}.sets.note`, { unit: 'bytes', min: 0, max: 4000, trim: false, nfc: false }),
    new ChoiceSpec(`${command}.sets.kind`, ['warmup', 'working', 'drop', 'failure']),
  ]),
]);

/**
 * @param {Record<string, Json>} fields
 * @returns {Record<string, Json>}
 */
function omittingNull(fields) { return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)); }

/** @param {Fields} f */
function targetForm(f) { return omittingNull({ reps: f.optionalInt('reps'), weightKg: f.optionalDouble('weightKg') }); }

/** @param {Fields} f */
function targetsForm(f) { return omittingNull({ sets: f.optionalList('sets', targetForm), restSeconds: f.optionalInt('restSeconds') }); }

/** @param {Fields} f */
function changeForm(f) {
  return omittingNull({ kind: f.string('kind'), exerciseId: f.ref('exerciseId', Exercise).json,
    before: f.optionalValue('before', targetsForm), after: f.optionalValue('after', targetsForm) });
}

/**
 * @param {Json} value
 * @param {Path} path
 * @param {ReturnType<typeof targetSpecs>} specs
 * @param {'routine' | 'proposal'} subject
 */
function validateTargets(value, path, specs, subject) {
  const fields = Fields.object(value, subject, path.text);
  const sets = specs.sets.applyOptional(fields.optionalList('sets', targetForm), path.plus('sets'), (item, at) => {
    const target = Fields.object(item, subject, at.text);
    const rawReps = target.optionalInt('reps');
    const rawWeight = target.optionalDouble('weightKg');
    if (rawReps === 0) throw new Violation(`${subject}.zeroTarget`, at.plus('reps'), { kind: 'custom', custom: 'zeroTarget' });
    const reps = specs.reps.applyOptional(rawReps, at.plus('reps'));
    const weightKg = specs.weight.applyOptional(rawWeight, at.plus('weightKg'));
    if (weightKg === 0 && (subject === 'proposal' || rawWeight !== 0)) {
      throw new Violation(`${subject}.zeroTarget`, at.plus('weightKg'), { kind: 'custom', custom: 'zeroTarget' });
    }
    return omittingNull({ reps, weightKg });
  });
  return omittingNull({ sets, restSeconds: specs.rest.applyOptional(fields.optionalInt('restSeconds'), path.plus('restSeconds')) });
}

// The book's field-validated records share one immutable value; feature-specific reads use their own value types.
class GymRecord {
  /**
   * @param {Id<GymRecord>} id
   * @param {Record<string, Json>} fields
   */
  constructor(id, fields) {
    this.id = id;
    this.values = /** @type {Record<string, Json>} */ (frozenJson(fields));
    Object.freeze(this);
  }

  fields() { return { ...this.values }; }
}

/**
 * @param {Json} value
 * @returns {Json}
 */
function frozenJson(value) {
  if (Array.isArray(value)) return /** @type {Json[]} */ (Object.freeze(value.map(frozenJson)));
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, frozenJson(item)])));
  }
  return value;
}

/**
 * @param {string} type
 * @param {(f: Fields) => Record<string, Json>} decode
 * @param {Record<string, (f: Fields, path: Path) => Json> | null} checks
 * @param {{ heldRemoval?: boolean, orderField?: string, savesGuarded?: boolean }} protocols
 * @returns {EntityType<GymRecord>}
 */
function entity(type, decode, checks, protocols = {}) {
  /** @type {EntityType<GymRecord>} */
  const declared = new EntityType({ type, scope: 'self/gym', ...protocols,
    decode: (f) => new GymRecord(new Id(f.id, declared), decode(f)),
    ...(checks === null ? {} : { checks: Object.entries(checks).map(([field, apply]) => new Check(field, (value) =>
      new GymRecord(value.id, { ...value.fields(), [field]: apply(Fields.values(type, value.id.record, value.fields()), new Path(field)) }))) }),
  });
  return declared;
}

export const Note = entity('note', (f) => ({ title: f.string('title'), body: f.string('body', '') }), {
  title: (f, path) => NoteRules.title.apply(f.string('title'), path),
  body: (f, path) => NoteRules.body.apply(f.string('body'), path),
}, { heldRemoval: true, orderField: 'ord', savesGuarded: true });

export const Session = entity('session', (f) => ({ startedAt: f.instant('startedAt').ms,
  finishedAt: f.optionalInstant('finishedAt')?.ms ?? null, closedBy: f.optionalString('closedBy'),
  routineId: f.optionalRef('routineId', Routine)?.json ?? null,
  historyRoutineId: f.optionalRef('historyRoutineId', Routine)?.json ?? null,
  plan: f.json('plan') ?? null, displayName: f.optionalString('displayName') }), null, { heldRemoval: true });

export const TrainingSet = entity('set', (f) => ({ sessionId: f.ref('sessionId', Session).json,
  exerciseId: f.ref('exerciseId', Exercise).json, weightKg: f.double('weightKg'), reps: f.int('reps'),
  kind: f.string('kind', 'working'), rpe: f.optionalDouble('rpe'), note: f.string('note', ''), completedAt: f.instant('completedAt').ms }), {
  weightKg: (f, path) => SetRules.weightKg.apply(f.double('weightKg'), path),
  reps: (f, path) => SetRules.reps.apply(f.int('reps'), path),
  kind: (f, path) => SetRules.kind.apply(f.string('kind'), path),
  rpe: (f, path) => SetRules.rpe.applyOptional(f.optionalDouble('rpe'), path),
  note: (f, path) => SetRules.note.apply(f.string('note'), path),
  completedAt: (f, path) => SessionRules.instant(f.instant('completedAt').ms, 'set.completedAt', path),
}, { heldRemoval: true });

export const Proposal = entity('proposal', (f) => ({ routineId: f.ref('routineId', Routine).json,
  intent: f.string('intent'), proposedName: f.string('proposedName', ''), summary: f.string('summary', ''),
  changes: f.list('changes', changeForm), door: f.string('door', 'ask'), connection: f.string('connection', ''), agent: f.string('agent', '') }), {
  intent: (f, path) => ProposalRules.intent.apply(f.string('intent'), path),
  proposedName: (f, path) => ProposalRules.name.apply(f.string('proposedName'), path),
  summary: (f, path) => ProposalRules.summary.apply(f.string('summary'), path),
  changes: (f, path) => {
    const changes = ProposalRules.changes.apply(f.list('changes', changeForm), path, (change, at) => {
      const fields = Fields.object(change, 'proposal', at.text);
      const kind = ProposalRules.kind.apply(fields.string('kind'), at.plus('kind'));
      const exerciseId = fields.ref('exerciseId', Exercise).json;
      ProposalRules.exercise.apply(typeof exerciseId === 'string' ? exerciseId : '', at.plus('exerciseId'));
      const before = fields.optionalValue('before', targetsForm);
      const after = fields.optionalValue('after', targetsForm);
      if ((kind === 'added') !== (before === null) || (kind === 'removed') !== (after === null)) {
        throw new Violation('proposal.changes', at, { kind: 'custom', custom: 'side' });
      }
      return omittingNull({ kind, exerciseId,
        before: before === null ? null : validateTargets(before, at.plus('before'), ProposalRules.before, 'proposal'),
        after: after === null ? null : validateTargets(after, at.plus('after'), ProposalRules.after, 'proposal') });
    });
    const removed = changes.findIndex((change) => change.kind === 'removed');
    if (removed >= 0 && changes.slice(removed).some((change) => change.kind !== 'removed')) {
      throw new Violation('proposal.changes', path, { kind: 'custom', custom: 'removalsLast' });
    }
    return changes;
  },
  door: (f, path) => ProposalRules.door.apply(f.string('door'), path),
  connection: (f, path) => ProposalRules.connection.apply(f.string('connection'), path),
  agent: (f, path) => ProposalRules.agent.apply(f.string('agent'), path),
});

/** @type {RuleBook | null} */
let book = null;

export const GymRules = Object.freeze({
  get specs() {
    const { targets, ...routine } = RoutineRules;
    const { before, after, ...proposal } = ProposalRules;
    return Object.freeze([...Object.values(NoteRules), WeighInRules.kg, PreferencesRules.units,
      ...Object.values(ExerciseRules), ...Object.values(routine), ...Object.values(targets),
      ...Object.values(proposal), ...Object.values(before), ...Object.values(after), ...Object.values(SetRules), ...CommandSpecs]);
  },
  /** @param {string} path */
  spec(path) { return GymRules.specs.find((spec) => spec.path === path) ?? null; },
  get book() {
    if (book !== null) return book;
    book = new RuleBook(registry, [Note, WeighIn, Preferences, Exercise, ExerciseName, Routine, Session, TrainingSet, Proposal], [
      ...GymRules.specs.map((spec) => Rule.localSpec(spec)),
      Rule.localCheck(WeighInRules.day, 'weighin', ['bad-instant']),
      ...['routine.order', 'routine.zeroTarget', 'proposal.zeroTarget', 'set.completedAt', 'set.identity', 'set.setNumber',
        'session.startedAt', 'session.finishedAt', 'session.sets', 'session.requestId']
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
    ]);
    return book;
  },
});
