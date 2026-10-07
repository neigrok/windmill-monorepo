// @ts-check

import { EntityType, Id } from '../../../platform/domain-kit/entities.js';
import { Check } from '../../../platform/domain-kit/validation.js';
import { ChoiceSpec, NumberSpec, Path, TextSpec, Violation } from '../../../platform/domain-kit/values.js';
import { Exercise } from './catalogue.js';
import { PlanSnapshot, Routine } from './routines.js';

/** @typedef {import('../../../platform/domain-kit/time.js').Instant} Instant */
/** @typedef {import('./catalogue.js').ExerciseValue} ExerciseValue */
/** @typedef {import('./routines.js').RoutineValue} RoutineValue */

export class SessionValue {
  /**
   * @param {Id<SessionValue>} id
   * @param {Instant} startedAt
   * @param {Instant | null} finishedAt
   * @param {string | null} closedBy
   * @param {Id<RoutineValue> | null} routineId
   * @param {Id<RoutineValue> | null} historyRoutineId
   * @param {PlanSnapshot | null} plan
   * @param {string | null} displayName
   */
  constructor(id, startedAt, finishedAt = null, closedBy = null, routineId = null, historyRoutineId = routineId, plan = null, displayName = null) {
    this.id = id;
    this.startedAt = startedAt;
    this.finishedAt = finishedAt;
    this.closedBy = closedBy;
    this.routineId = routineId;
    this.historyRoutineId = historyRoutineId;
    this.plan = plan;
    this.displayName = displayName;
    Object.freeze(this);
  }

  get isOpen() { return this.finishedAt === null; }
  get name() { return this.displayName ?? this.plan?.routine ?? null; }

  fields() {
    return { startedAt: this.startedAt.ms, finishedAt: this.finishedAt?.ms ?? null, closedBy: this.closedBy,
      routineId: this.routineId?.json ?? null, historyRoutineId: this.historyRoutineId?.json ?? null,
      plan: this.plan?.json ?? null, displayName: this.displayName };
  }
}

/** @type {EntityType<SessionValue>} */
export const Session = new EntityType({
  type: 'session', scope: 'self/gym', heldRemoval: true,
  decode: (f) => new SessionValue(new Id(f.id, Session), f.instant('startedAt'), f.optionalInstant('finishedAt'),
    f.optionalString('closedBy'), f.optionalRef('routineId', Routine), f.optionalRef('historyRoutineId', Routine),
    PlanSnapshot.decode(f.json('plan')), f.optionalString('displayName')),
});

export const GymEstimate = Object.freeze({
  /** @param {number} weightKg @param {number} reps @param {string} kind @param {number | null} rpe */
  value(weightKg, reps, kind = 'working', rpe = null) {
    if (kind !== 'working' || !Number.isFinite(weightKg) || weightKg <= 0 || !Number.isInteger(reps) || reps < 1 || reps > 10
      || (rpe !== null && (!Number.isFinite(rpe) || rpe < 7))) return null;
    return reps === 1 ? weightKg : weightKg * (1 + reps / 30);
  },
});

export class TrainingSetValue {
  /**
   * @param {Id<TrainingSetValue>} id
   * @param {Id<SessionValue>} sessionId
   * @param {Id<ExerciseValue>} exerciseId
   * @param {number} weightKg
   * @param {number} reps
   * @param {Instant} completedAt
   * @param {string} kind
   * @param {number | null} rpe
   * @param {string} note
   * @param {number | null} setNumber
   */
  constructor(id, sessionId, exerciseId, weightKg, reps, completedAt, kind = 'working', rpe = null, note = '', setNumber = null) {
    this.id = id;
    this.sessionId = sessionId;
    this.exerciseId = exerciseId;
    this.weightKg = weightKg;
    this.reps = reps;
    this.completedAt = completedAt;
    this.kind = kind;
    this.rpe = rpe;
    this.note = note;
    this.setNumber = setNumber;
    Object.freeze(this);
  }

  fields() {
    return { sessionId: this.sessionId.json, exerciseId: this.exerciseId.json, weightKg: this.weightKg, reps: this.reps,
      kind: this.kind, rpe: this.rpe, note: this.note, completedAt: this.completedAt.ms };
  }

  get volumeKg() { return this.kind === 'working' ? Math.max(0, this.weightKg) * this.reps : 0; }
  get e1rm() { return GymEstimate.value(this.weightKg, this.reps, this.kind, this.rpe); }
}

/** @type {EntityType<TrainingSetValue>} */
export const TrainingSet = new EntityType({
  type: 'set', scope: 'self/gym', heldRemoval: true,
  decode: (f) => new TrainingSetValue(new Id(f.id, TrainingSet), f.ref('sessionId', Session), f.ref('exerciseId', Exercise),
    f.double('weightKg'), f.int('reps'), f.instant('completedAt'), f.string('kind', 'working'), f.optionalDouble('rpe'),
    f.string('note', ''), f.serial('setNumber') ?? f.optionalInt('setNumber')),
  checks: [
    new Check('weightKg', (s) => new TrainingSetValue(s.id, s.sessionId, s.exerciseId,
      SetRules.weightKg.apply(s.weightKg, new Path('weightKg')), s.reps, s.completedAt, s.kind, s.rpe, s.note, s.setNumber)),
    new Check('reps', (s) => new TrainingSetValue(s.id, s.sessionId, s.exerciseId, s.weightKg,
      SetRules.reps.apply(s.reps, new Path('reps')), s.completedAt, s.kind, s.rpe, s.note, s.setNumber)),
    new Check('kind', (s) => new TrainingSetValue(s.id, s.sessionId, s.exerciseId, s.weightKg, s.reps, s.completedAt,
      SetRules.kind.apply(s.kind, new Path('kind')), s.rpe, s.note, s.setNumber)),
    new Check('rpe', (s) => new TrainingSetValue(s.id, s.sessionId, s.exerciseId, s.weightKg, s.reps, s.completedAt,
      s.kind, SetRules.rpe.applyOptional(s.rpe, new Path('rpe')), s.note, s.setNumber)),
    new Check('note', (s) => new TrainingSetValue(s.id, s.sessionId, s.exerciseId, s.weightKg, s.reps, s.completedAt,
      s.kind, s.rpe, SetRules.note.apply(s.note, new Path('note')), s.setNumber)),
    new Check('completedAt', (s) => { SessionRules.instant(s.completedAt, 'set.completedAt', new Path('completedAt')); return s; }),
  ],
});

export const SetRules = Object.freeze({
  weightKg: new NumberSpec('set.weightKg', { min: -500, max: 500, quantum: 0.01 }),
  reps: new NumberSpec('set.reps', { min: 1, max: 500, integer: true }),
  kind: new ChoiceSpec('set.kind', ['warmup', 'working', 'drop', 'failure']),
  rpe: new NumberSpec('set.rpe', { min: 1, max: 10, quantum: 0.1 }),
  note: new TextSpec('set.note', { unit: 'bytes', min: 0, max: 4000, trim: false, nfc: false }),
  maxNumber: 2_147_483_647,
  /** @param {readonly TrainingSetValue[]} sets @param {Id<SessionValue>} sessionId @param {Id<ExerciseValue>} exerciseId */
  nextNumber(sets, sessionId, exerciseId) {
    const numbers = sets.filter((set) => set.sessionId.equals(sessionId) && set.exerciseId.equals(exerciseId))
      .flatMap((set) => set.setNumber === null ? [] : [set.setNumber]);
    const last = numbers.length === 0 ? 0 : Math.max(...numbers);
    return last >= SetRules.maxNumber ? null : last + 1;
  },
});

export const SessionRules = Object.freeze({
  staleAfterMs: 4 * 60 * 60 * 1000,
  maxClockAheadMs: 5 * 60 * 1000,
  maxInstantMs: 253_402_300_799_000,
  /** @param {Instant} value @param {string} rule @param {Path} path */
  instant(value, rule, path) {
    if (value.ms <= 0) throw new Violation(rule, path, { kind: 'below', min: 1 });
    if (value.ms > SessionRules.maxInstantMs) throw new Violation(rule, path, { kind: 'above', max: SessionRules.maxInstantMs });
  },
  /** @param {SessionValue} session @param {readonly TrainingSetValue[]} sets */
  lastActivity(session, sets) {
    const times = sets.filter((set) => set.sessionId.equals(session.id)).map((set) => set.completedAt);
    return times.reduce((latest, at) => latest === null || at.ms > latest.ms ? at : latest, /** @type {Instant | null} */ (null))
      ?? session.startedAt;
  },
  /** @param {SessionValue} session @param {readonly TrainingSetValue[]} sets @param {Instant} now */
  autoCloseAt(session, sets, now) {
    if (!session.isOpen) return null;
    const last = SessionRules.lastActivity(session, sets);
    return now.ms - last.ms >= SessionRules.staleAfterMs ? last : null;
  },
  /** @param {SessionValue} session @param {readonly TrainingSetValue[]} sets @param {Instant} now */
  drawn(session, sets, now) {
    const finish = SessionRules.autoCloseAt(session, sets, now);
    return finish === null ? session : new SessionValue(session.id, session.startedAt, finish, 'stale',
      session.routineId, session.historyRoutineId, session.plan, session.displayName);
  },
  /** @param {SessionValue} session @param {Instant} at */
  canFinishAt(session, at) { return at.ms > 0 && at.ms >= session.startedAt.ms && at.ms <= SessionRules.maxInstantMs; },
  /** @param {Instant} at @param {Instant} now */
  canStartAt(at, now) { return at.ms > 0 && at.ms <= SessionRules.maxInstantMs && at.ms - now.ms <= SessionRules.maxClockAheadMs; },
  /** @param {SessionValue} session @param {Instant} completedAt */
  lateSetLands(session, completedAt) {
    return session.finishedAt === null || (session.closedBy === 'stale' && completedAt.ms <= session.finishedAt.ms + SessionRules.staleAfterMs);
  },
  /** @param {SessionValue} session @param {Instant} at */
  finish(session, at) {
    if (!SessionRules.canFinishAt(session, at)) throw new Violation('session.finishedAt', new Path('finishedAt'), { kind: 'custom', custom: 'badInstant' });
    if (session.finishedAt !== null && session.closedBy !== 'stale') return session;
    const finish = session.finishedAt;
    const selected = finish === null ? at : at.ms > finish.ms + SessionRules.staleAfterMs || finish.ms >= at.ms ? finish : at;
    return new SessionValue(session.id, session.startedAt, selected, 'finish', session.routineId, session.historyRoutineId, session.plan, session.displayName);
  },
  /** @param {Instant} startedAt @param {Instant} finishedAt @param {SessionValue} other */
  crosses(startedAt, finishedAt, other) {
    if (other.finishedAt === null) return false;
    return startedAt.ms < Math.max(other.finishedAt.ms, other.startedAt.ms + 1)
      && other.startedAt.ms < Math.max(finishedAt.ms, startedAt.ms + 1);
  },
});
