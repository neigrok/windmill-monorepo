// @ts-check

import { DecodeError, EntityType, Id, compareText } from '../../../platform/domain-kit/entities.js';
import { Check } from '../../../platform/domain-kit/validation.js';
import { NumberSpec, Path, TextSpec, Violation, precondition } from '../../../platform/domain-kit/values.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { roundToQuantum } from '../../../../../packages/api-contract/sync/reference/core/values.js';
import { Exercise } from './catalogue.js';
import { WorkoutPlanRules } from './gymRules.js';
import { PlanSnapshot, Routine } from './routines.js';

/** @typedef {import('../../../platform/domain-kit/time.js').Instant} Instant */
/** @typedef {import('./catalogue.js').ExerciseValue} ExerciseValue */
/** @typedef {import('./routines.js').RoutineValue} RoutineValue */
/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */

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
   * @param {Json | null} unreadablePlan
   * @param {number | null} planRevision
   * @param {number | null} routineRevision
   */
  constructor(id, startedAt, finishedAt = null, closedBy = null, routineId = null, historyRoutineId = routineId, plan = null, displayName = null,
    unreadablePlan = null, planRevision = null, routineRevision = null) {
    this.id = id;
    this.startedAt = startedAt;
    this.finishedAt = finishedAt;
    this.closedBy = closedBy;
    this.routineId = routineId;
    this.historyRoutineId = historyRoutineId;
    this.plan = plan;
    this.displayName = displayName;
    this.unreadablePlan = unreadablePlan;
    this.planRevision = planRevision;
    this.routineRevision = routineRevision;
    Object.freeze(this);
  }

  /** @param {{ finishedAt?: Instant | null, closedBy?: string | null, plan?: PlanSnapshot | null }} changes */
  with(changes) {
    const next = { finishedAt: this.finishedAt, closedBy: this.closedBy, plan: this.plan, ...changes };
    return new SessionValue(this.id, this.startedAt, next.finishedAt, next.closedBy, this.routineId, this.historyRoutineId, next.plan,
      this.displayName, this.unreadablePlan, this.planRevision, this.routineRevision);
  }

  get isOpen() { return this.finishedAt === null; }
  get name() { return this.displayName ?? this.plan?.routine ?? null; }
  get planUnreadable() { return this.unreadablePlan !== null; }

  fields() {
    return { startedAt: this.startedAt.ms, finishedAt: this.finishedAt?.ms ?? null, closedBy: this.closedBy,
      routineId: this.routineId?.json ?? null, historyRoutineId: this.historyRoutineId?.json ?? null,
      plan: this.unreadablePlan ?? this.plan?.json ?? null, displayName: this.displayName };
  }
}

/** @type {EntityType<SessionValue>} */
export const Session = new EntityType({
  type: 'session', scope: 'self/gym', heldRemoval: true,
  checks: [
    new Check('plan', (value) => value.plan === null ? value : value.with({ plan: new PlanSnapshot(value.plan.routine,
      WorkoutPlanRules.entries.apply([...value.plan.entries], new Path('plan.entries'), (entry) => entry)) })),
  ],
  decode: (f) => {
    let plan = null;
    let unreadablePlan = null;
    try { plan = PlanSnapshot.decode(f.json('plan')); }
    catch (error) {
      if (!(error instanceof DecodeError)) throw error;
      unreadablePlan = f.json('plan') ?? null;
    }
    return new SessionValue(new Id(f.id, Session), f.instant('startedAt'), f.optionalInstant('finishedAt'),
      f.optionalString('closedBy'), f.optionalRef('routineId', Routine), f.optionalRef('historyRoutineId', Routine),
      plan, f.optionalString('displayName'), unreadablePlan, f.optionalInt('planRevision'), f.optionalInt('routineRevision'));
  },
});

export class EstimateScore {
  static zero = new EstimateScore(0, 1);

  /** @param {number} weightKg @param {number} reps */
  constructor(weightKg, reps) {
    precondition(Number.isFinite(weightKg) && weightKg >= 0 && Number.isInteger(reps) && reps >= 1 && reps <= 10, 'invalid estimate score');
    const [mantissa, power = '0'] = jcs(roundToQuantum(weightKg, 0.01)).split('e');
    const point = mantissa.indexOf('.');
    let exponent = Number(power) + 2 - (point < 0 ? 0 : mantissa.length - point - 1);
    const digits = mantissa.replace('.', '').replace(/^0+/, '') || '0';
    let product = '';
    let carry = 0;
    const factor = reps === 1 ? 30 : 30 + reps;
    for (let index = digits.length - 1; index >= 0; index--) {
      const number = Number(digits[index]) * factor + carry;
      product = String(number % 10) + product;
      carry = Math.floor(number / 10);
    }
    if (carry > 0) product = String(carry) + product;
    while (product.length > 1 && product.endsWith('0')) { product = product.slice(0, -1); exponent++; }
    this.digits = product;
    this.exponent = product === '0' ? 0 : exponent;
    Object.freeze(this);
  }

  /** @param {EstimateScore} other @returns {number} */
  compare(other) {
    if (this.digits === '0' || other.digits === '0') return Number(this.digits !== '0') - Number(other.digits !== '0');
    const length = this.digits.length + this.exponent;
    const otherLength = other.digits.length + other.exponent;
    if (length !== otherLength) return length < otherLength ? -1 : 1;
    for (let index = 0; index < Math.max(this.digits.length, other.digits.length); index++) {
      const left = this.digits[index] ?? '0', right = other.digits[index] ?? '0';
      if (left !== right) return left < right ? -1 : 1;
    }
    return 0;
  }
}

export const GymEstimate = Object.freeze({
  /** @param {number} weightKg @param {number} reps @param {number | null} rpe */
  qualifies(weightKg, reps, rpe) {
    return Number.isFinite(weightKg) && weightKg > 0 && Number.isInteger(reps) && reps >= 1 && reps <= 10
      && (rpe === null || Number.isFinite(rpe) && rpe >= 7);
  },
  /** @param {number} weightKg @param {number} reps @param {number | null} rpe */
  value(weightKg, reps, rpe = null) {
    if (!GymEstimate.qualifies(weightKg, reps, rpe)) return null;
    const value = reps === 1 ? weightKg : weightKg * (1 + reps / 30);
    return Number.isFinite(value) ? value : null;
  },
  /** @param {number} weightKg @param {number} reps @param {number | null} rpe */
  score(weightKg, reps, rpe = null) {
    if (!GymEstimate.qualifies(weightKg, reps, rpe)) return null;
    return new EstimateScore(weightKg, reps);
  },
  // An estimate as the log states it, to a tenth of a kilogram.
  /** @param {number} e1rm */
  stated(e1rm) { return roundToQuantum(e1rm, 0.1); },
  /** @param {readonly TrainingSetValue[]} sets */
  top(sets) {
    const eligible = sets.filter((set) => GymEstimate.qualifies(set.weightKg, set.reps, set.rpe));
    if (eligible.some((set) => set.e1rm === null)) return null;
    const estimates = eligible.flatMap((set) => set.e1rm === null ? [] : [set.e1rm]);
    return estimates.length === 0 ? null : Math.max(...estimates);
  },
});

export class VolumePart {
  /** @param {string} id @param {number | null} weightKg @param {number | null} reps @param {number | null} loadCount */
  constructor(id, weightKg, reps, loadCount) {
    this.id = id;
    /** @type {number | null} */
    this.kg = null;
    if (weightKg === null || !Number.isFinite(weightKg) || reps === null || !Number.isInteger(reps) || reps <= 0
      || loadCount === null || !Number.isInteger(loadCount) || loadCount <= 0) { Object.freeze(this); return; }
    const lifted = Math.max(weightKg, 0) * reps;
    if (!Number.isFinite(lifted)) { Object.freeze(this); return; }
    const volume = lifted * loadCount;
    this.kg = Number.isFinite(volume) ? volume : null;
    Object.freeze(this);
  }
}

export const GymVolume = Object.freeze({
  /** @param {readonly VolumePart[]} parts @returns {number | null} */
  total(parts) {
    let total = 0;
    for (const part of [...parts].sort((a, b) => compareText(a.id, b.id))) {
      if (part.kg === null) return null;
      total += part.kg;
      if (!Number.isFinite(total)) return null;
    }
    return total;
  },
  /** @param {readonly TrainingSetValue[]} sets @param {import('./catalogue.js').Catalogue} catalogue */
  of(sets, catalogue) {
    return GymVolume.total(sets.map((set) => new VolumePart(jcs(set.id.json), set.weightKg, set.reps,
      catalogue.find(set.exerciseId)?.loadCount ?? null)));
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
   * @param {number | null} rpe
   * @param {string} note
   * @param {number | null} setNumber
   */
  constructor(id, sessionId, exerciseId, weightKg, reps, completedAt, rpe = null, note = '', setNumber = null) {
    this.id = id;
    this.sessionId = sessionId;
    this.exerciseId = exerciseId;
    this.weightKg = weightKg;
    this.reps = reps;
    this.completedAt = completedAt;
    this.rpe = rpe;
    this.note = note;
    this.setNumber = setNumber;
    Object.freeze(this);
  }

  fields() {
    return { sessionId: this.sessionId.json, exerciseId: this.exerciseId.json, weightKg: this.weightKg, reps: this.reps,
      rpe: this.rpe, note: this.note, completedAt: this.completedAt.ms };
  }

  get volumeKg() { return new VolumePart(jcs(this.id.json), this.weightKg, this.reps, 1).kg; }
  /** @param {ExerciseValue | null} exercise */
  volumeFor(exercise) { return new VolumePart(jcs(this.id.json), this.weightKg, this.reps, exercise?.loadCount ?? null).kg; }
  get e1rm() { return GymEstimate.value(this.weightKg, this.reps, this.rpe); }
}

/** @type {EntityType<TrainingSetValue>} */
export const TrainingSet = new EntityType({
  type: 'set', scope: 'self/gym', heldRemoval: true,
  decode: (f) => new TrainingSetValue(new Id(f.id, TrainingSet), f.ref('sessionId', Session), f.ref('exerciseId', Exercise),
    f.double('weightKg'), f.int('reps'), f.instant('completedAt'), f.optionalDouble('rpe'),
    f.string('note', ''), f.serial('setNumber') ?? f.optionalInt('setNumber')),
  checks: [
    new Check('weightKg', (s) => new TrainingSetValue(s.id, s.sessionId, s.exerciseId,
      SetRules.weightKg.apply(s.weightKg, new Path('weightKg')), s.reps, s.completedAt, s.rpe, s.note, s.setNumber)),
    new Check('reps', (s) => new TrainingSetValue(s.id, s.sessionId, s.exerciseId, s.weightKg,
      SetRules.reps.apply(s.reps, new Path('reps')), s.completedAt, s.rpe, s.note, s.setNumber)),
    new Check('rpe', (s) => new TrainingSetValue(s.id, s.sessionId, s.exerciseId, s.weightKg, s.reps, s.completedAt,
      SetRules.rpe.applyOptional(s.rpe, new Path('rpe')), s.note, s.setNumber)),
    new Check('note', (s) => new TrainingSetValue(s.id, s.sessionId, s.exerciseId, s.weightKg, s.reps, s.completedAt,
      s.rpe, SetRules.note.apply(s.note, new Path('note')), s.setNumber)),
    new Check('completedAt', (s) => { SessionRules.instant(s.completedAt, 'set.completedAt', new Path('completedAt')); return s; }),
  ],
});

export const SetRules = Object.freeze({
  weightKg: new NumberSpec('set.weightKg', { quantum: 0.01 }),
  reps: new NumberSpec('set.reps', { min: 1, max: 500, integer: true }),
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
    return finish === null ? session : session.with({ finishedAt: finish, closedBy: 'stale' });
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
    return session.with({ finishedAt: selected, closedBy: 'finish' });
  },
  /** @param {Instant} startedAt @param {Instant} finishedAt @param {SessionValue} other */
  crosses(startedAt, finishedAt, other) {
    if (other.finishedAt === null) return false;
    return startedAt.ms < Math.max(other.finishedAt.ms, other.startedAt.ms + 1)
      && other.startedAt.ms < Math.max(finishedAt.ms, startedAt.ms + 1);
  },
});
