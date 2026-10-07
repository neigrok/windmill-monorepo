// @ts-check

import { Decision } from '../../../platform/domain-kit/actions.js';
import { Id, sameJson } from '../../../platform/domain-kit/entities.js';
import { Plan, Prediction } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Remove } from '../../../platform/domain-kit/standardActions.js';
import { Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation, precondition } from '../../../platform/domain-kit/values.js';
import { Catalogue } from './catalogue.js';
import { CommandSpecs, GymRefusals } from './gymRules.js';
import { PlanSnapshot, Routine } from './routines.js';
import { Session, SessionRules, SessionValue, SetRules, TrainingSet, TrainingSetValue } from './training.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/time.js').Instant} Instant */
/** @typedef {import('./catalogue.js').ExerciseValue} ExerciseValue */
/** @typedef {import('./routines.js').RoutineValue} RoutineValue */

export const MAX_SESSION_SETS = 200;

export class TrainingState {
  /** @param {Reader} read */
  constructor(read) {
    this.drawn = Object.freeze(read.repository(Session).all('drawn'));
    this.stored = Object.freeze(read.repository(Session).all('stored'));
    this.sets = Object.freeze(read.repository(TrainingSet).all('stored'));
    this.drawnSets = Object.freeze(read.repository(TrainingSet).all('drawn'));
    this.catalogue = new Catalogue(read, 'stored');
    this.moment = read.moment;
    Object.freeze(this);
  }

  /** @param {Id<SessionValue>} id */
  session(id) { return this.stored.find((session) => session.id.equals(id)) ?? this.drawn.find((session) => session.id.equals(id)) ?? null; }
}

/** @param {{ id: Id<SessionValue>, routineId?: Id<RoutineValue> | null, startedAt?: Instant | null }} input */
export function StartSession({ id, routineId = null, startedAt = null }) {
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) {
      return { state: new TrainingState(read), routine: routineId === null ? null : read.repository(Routine).find(routineId, 'drawn'),
        prior: read.repository(Session).record(id.record, 'stored') !== undefined };
    },
    /** @param {{ state: TrainingState, routine: RoutineValue | null, prior: boolean }} loaded */
    decide({ state, routine, prior }) {
      if (prior) return Decision.unchanged(id);
      const at = startedAt ?? state.moment.now;
      const command = { name: 'gym.start', args: { id: id.json, startedAt: at.ms, joinOpenSession: true,
        ...(routineId === null ? {} : { routineId: routineId.json }) }, specs: [] };
      const open = state.stored.find((session) => SessionRules.drawn(session, state.sets, state.moment.now).isOpen);
      if (open !== undefined) return Decision.write(Plan.running(command), open.id);
      SessionRules.instant(at, 'session.startedAt', new Path('startedAt'));
      const predicted = new SessionValue(id, at, null, null, routine?.id ?? null, routine?.id ?? null,
        routine === null ? null : PlanSnapshot.fromRoutine(routine));
      return Decision.write(Plan.running(command, [Prediction.create(id, predicted.fields())]), id);
    },
  });
}

/** @param {{ id: Id<SessionValue>, finishedAt?: Instant | null }} input */
export function FinishSession({ id, finishedAt = null }) {
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return new TrainingState(read); },
    /** @param {TrainingState} loaded */
    decide(loaded) {
      const session = loaded.session(id);
      if (session === null || !loaded.drawn.some((drawn) => drawn.id.equals(id))) {
        return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-record', id.ref, null, 'predicted')));
      }
      const at = finishedAt ?? loaded.moment.now;
      if (!SessionRules.canFinishAt(session, at)) return Decision.refuse(GymRefusals.ofRefused(new Refused('bad-instant', id.ref, null, 'predicted')));
      const finished = SessionRules.finish(session, at);
      if (sameJson(finished.fields(), session.fields())) return Decision.unchanged(null);
      precondition(finished.finishedAt !== null, 'a finished session has a finish instant');
      const command = { name: 'gym.finish', args: { sessionId: id.json, finishedAt: at.ms }, specs: [] };
      return Decision.write(Plan.running(command, [Prediction.update(id, { finishedAt: finished.finishedAt.ms, closedBy: 'finish' })]), null);
    },
  });
}

/** @param {TrainingSetValue} value */
export function AppendSet(value) {
  return Object.freeze({
    scope: TrainingSet.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return new TrainingState(read); },
    /** @param {TrainingState} loaded */
    decide(loaded) {
      const valid = new Valid(value, loaded.moment);
      const session = loaded.session(value.sessionId);
      if (session === null || !loaded.drawn.some((drawn) => drawn.id.equals(value.sessionId))) {
        return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-record', value.sessionId.ref, null, 'predicted')));
      }
      if (!SessionRules.lateSetLands(session, value.completedAt)) {
        return Decision.refuse(GymRefusals.ofRefused(new Refused('session-finished', value.id.ref, null, 'predicted')));
      }
      if (loaded.catalogue.find(value.exerciseId) === null) return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-exercise', value.id.ref, null, 'predicted')));
      if (loaded.sets.some((set) => set.id.equals(value.id))) return Decision.refuse(GymRefusals.ofRefused(new Refused('id-taken', value.id.ref, null, 'predicted')));
      if (SetRules.nextNumber(loaded.sets, value.sessionId, value.exerciseId) === null) {
        throw new Violation('set.setNumber', new Path('setNumber'), { kind: 'above', max: SetRules.maxNumber });
      }
      const plan = new Plan();
      plan.create(valid);
      return Decision.write(plan, value.id);
    },
  });
}

/** @param {TrainingSetValue} value @param {TrainingSetValue | null} original */
export function CorrectSet(value, original = null) {
  return Object.freeze({
    scope: TrainingSet.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return new TrainingState(read); },
    /** @param {TrainingState} loaded */
    decide(loaded) {
      const old = loaded.sets.find((set) => set.id.equals(value.id));
      if (old === undefined || !loaded.drawnSets.some((drawn) => drawn.id.equals(value.id))) {
        return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-record', value.id.ref, null, 'predicted')));
      }
      /** @type {Array<'weightKg' | 'reps' | 'kind' | 'rpe' | 'note'>} */
      const fields = ['weightKg', 'reps', 'kind', 'rpe', 'note'];
      let correction = value;
      if (original !== null) {
        if (!original.id.equals(value.id) || !original.sessionId.equals(value.sessionId) || !original.exerciseId.equals(value.exerciseId)
          || original.completedAt.ms !== value.completedAt.ms || original.setNumber !== value.setNumber) {
          throw new Violation('set.identity', new Path('id'), { kind: 'custom', custom: 'immutable' });
        }
        if (!old.sessionId.equals(original.sessionId) || !old.exerciseId.equals(original.exerciseId)
          || fields.some((field) => old.fields()[field] !== original.fields()[field])) {
          return Decision.refuse(GymRefusals.ofRefused(new Refused('stale', value.id.ref, null, 'predicted')));
        }
        correction = new TrainingSetValue(old.id, old.sessionId, old.exerciseId, value.weightKg, value.reps,
          old.completedAt, value.kind, value.rpe, value.note, old.setNumber);
      }
      if (!old.sessionId.equals(correction.sessionId) || !old.exerciseId.equals(correction.exerciseId)
        || old.completedAt.ms !== correction.completedAt.ms || old.setNumber !== correction.setNumber) {
        throw new Violation('set.identity', new Path('id'), { kind: 'custom', custom: 'immutable' });
      }
      const valid = new Valid(correction, loaded.moment, fields);
      const changed = fields.filter((field) => valid.value.fields()[field] !== old.fields()[field]);
      if (changed.length === 0) return Decision.unchanged(null);
      const plan = new Plan();
      plan.update(valid, { fields: changed });
      return Decision.write(plan, null);
    },
  });
}

/** @param {Id<TrainingSetValue>} id */
export function DeleteSet(id) { return new Remove(id, GymRefusals); }

/** @param {Id<SessionValue>} id */
export function DiscardSession(id) {
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return new TrainingState(read); },
    /** @param {TrainingState} loaded */
    decide(loaded) {
      const session = loaded.session(id);
      if (session === null || !loaded.drawn.some((drawn) => drawn.id.equals(id))) return Decision.unchanged(null);
      if (session.isOpen && SessionRules.autoCloseAt(session, loaded.sets, loaded.moment.now) === null) {
        return Decision.refuse(GymRefusals.ofRefused(new Refused('session-open', id.ref, null, 'predicted')));
      }
      const plan = new Plan();
      plan.remove(id);
      return Decision.write(plan, null);
    },
  });
}

export class ImportedSet {
  /**
   * @param {{ id: Id<TrainingSetValue>, exerciseId: Id<ExerciseValue>, weightKg: number, reps: number,
   *   completedAt: Instant, kind?: string | null, rpe?: number | null, note?: string | null, rpeNamed?: boolean }} input
   */
  constructor({ id, exerciseId, weightKg, reps, completedAt, kind = null, rpe = null, note = null, rpeNamed = rpe !== null }) {
    this.id = id;
    this.exerciseId = exerciseId;
    this.weightKg = weightKg;
    this.reps = reps;
    this.completedAt = completedAt;
    this.kind = kind;
    this.rpe = rpe;
    this.note = note;
    this.rpeNamed = rpeNamed;
    Object.freeze(this);
  }

  /** @param {Id<SessionValue>} sessionId */
  value(sessionId) {
    return new TrainingSetValue(this.id, sessionId, this.exerciseId, this.weightKg, this.reps,
      this.completedAt, this.kind ?? 'working', this.rpe, this.note ?? '');
  }

  /** @returns {Record<string, Json>} */
  get json() {
    return { id: this.id.json, exerciseId: this.exerciseId.json, weightKg: this.weightKg, reps: this.reps, completedAt: this.completedAt.ms,
      ...(this.kind === null ? {} : { kind: this.kind }), ...(this.note === null ? {} : { note: this.note }),
      ...(this.rpeNamed ? { rpe: this.rpe } : {}) };
  }
}

/**
 * @param {{ id: Id<SessionValue>, startedAt: Instant, finishedAt: Instant, sets: readonly ImportedSet[],
 *   routineId?: Id<RoutineValue> | null }} input
 */
export function ImportSession({ id, startedAt, finishedAt, sets, routineId = null }) {
  const imported = Object.freeze([...sets]);
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) {
      return { state: new TrainingState(read), routine: routineId === null ? null : read.repository(Routine).find(routineId, 'drawn') };
    },
    /** @param {{ state: TrainingState, routine: RoutineValue | null }} loaded */
    decide({ state, routine }) {
      SessionRules.instant(startedAt, 'session.startedAt', new Path('startedAt'));
      SessionRules.instant(finishedAt, 'session.finishedAt', new Path('finishedAt'));
      if (imported.length > MAX_SESSION_SETS || imported.some((set, index) => imported.slice(0, index).some((prior) => prior.id.equals(set.id)))) {
        throw new Violation('session.sets', new Path('sets'), { kind: 'custom', custom: 'invalid' });
      }
      if (finishedAt.ms < startedAt.ms || imported.some((set) => set.completedAt.ms < startedAt.ms || set.completedAt.ms > finishedAt.ms)) {
        return Decision.refuse(GymRefusals.ofRefused(new Refused('bad-instant', id.ref, null, 'predicted')));
      }
      const checked = imported.map((set) => new Valid(set.value(id), state.moment).value);
      const predicted = new SessionValue(id, startedAt, finishedAt, 'finish', routine?.id ?? null, routine?.id ?? null,
        routine === null ? null : PlanSnapshot.fromRoutine(routine));
      const command = { name: 'gym.importSession', args: { id: id.json, startedAt: startedAt.ms, finishedAt: finishedAt.ms,
        sets: imported.map((set) => set.json), ...(routineId === null ? {} : { routineId: routineId.json }) },
      specs: CommandSpecs.filter((spec) => spec.path.startsWith('gym.importSession.')) };
      const predictions = [Prediction.create(id, predicted.fields()), ...checked.map((set) => Prediction.create(set.id, set.fields()))];
      return Decision.write(Plan.running(command, predictions), id);
    },
  });
}

export class CorrectedSet {
  /**
   * @param {{ id: Id<TrainingSetValue>, exerciseId: Id<ExerciseValue>, setNumber: number, weightKg: number, reps: number,
   *   completedAt: Instant, rpe?: number | null, note?: string | null, rpeNamed?: boolean, kind?: string | null }} input
   */
  constructor({ id, exerciseId, setNumber, weightKg, reps, completedAt, rpe = null, note = null, rpeNamed = rpe !== null, kind = null }) {
    this.id = id;
    this.exerciseId = exerciseId;
    this.setNumber = setNumber;
    this.weightKg = weightKg;
    this.reps = reps;
    this.completedAt = completedAt;
    this.rpe = rpe;
    this.note = note;
    this.rpeNamed = rpeNamed;
    this.kind = kind;
    Object.freeze(this);
  }

  /** @returns {Record<string, Json>} */
  get json() {
    return { id: this.id.json, exerciseId: this.exerciseId.json, setNumber: this.setNumber, weightKg: this.weightKg,
      reps: this.reps, completedAt: this.completedAt.ms, ...(this.kind === null ? {} : { kind: this.kind }),
      ...(this.note === null ? {} : { note: this.note }), ...(this.rpeNamed ? { rpe: this.rpe } : {}) };
  }
}

/**
 * @param {{ id: Id<SessionValue>, requestId: string, startedAt: Instant, finishedAt: Instant, routineName: string | null,
 *   sets: readonly CorrectedSet[], preserveOtherSets?: boolean }} input
 */
export function CorrectSession({ id, requestId, startedAt, finishedAt, routineName, sets, preserveOtherSets = false }) {
  const corrected = Object.freeze([...sets]);
  return Object.freeze({
    scope: Session.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return new TrainingState(read); },
    /** @param {TrainingState} loaded */
    decide(loaded) {
      if (requestId.length < 8 || requestId.length > 64 || /[^A-Za-z0-9_-]/.test(requestId)) {
        throw new Violation('session.requestId', new Path('requestId'), { kind: 'custom', custom: 'invalid' });
      }
      SessionRules.instant(startedAt, 'session.startedAt', new Path('startedAt'));
      SessionRules.instant(finishedAt, 'session.finishedAt', new Path('finishedAt'));
      if (corrected.length < 1 || corrected.length > MAX_SESSION_SETS || corrected.some((set, index) => !Number.isInteger(set.setNumber)
        || set.setNumber < 1 || set.setNumber > SetRules.maxNumber || corrected.slice(0, index).some((prior) =>
          prior.id.equals(set.id) || (prior.exerciseId.equals(set.exerciseId) && prior.setNumber === set.setNumber)))) {
        throw new Violation('session.sets', new Path('sets'), { kind: 'custom', custom: 'invalid' });
      }
      if (finishedAt.ms < startedAt.ms || corrected.some((set) => set.completedAt.ms < startedAt.ms || set.completedAt.ms > finishedAt.ms)) {
        return Decision.refuse(GymRefusals.ofRefused(new Refused('bad-instant', id.ref, null, 'predicted')));
      }
      const old = loaded.sets.filter((set) => set.sessionId.equals(id));
      const retained = preserveOtherSets ? old.filter((prior) => !corrected.some((set) => set.id.equals(prior.id))) : [];
      if (retained.some((set) => set.completedAt.ms < startedAt.ms || set.completedAt.ms > finishedAt.ms)) {
        return Decision.refuse(GymRefusals.ofRefused(new Refused('bad-instant', id.ref, null, 'predicted')));
      }
      if (corrected.some((named) => retained.some((set) => set.exerciseId.equals(named.exerciseId) && set.setNumber === named.setNumber))) {
        throw new Violation('session.sets', new Path('sets'), { kind: 'custom', custom: 'invalid' });
      }
      const checked = corrected.map((set) => {
        const previous = loaded.sets.find((prior) => prior.id.equals(set.id));
        const value = new TrainingSetValue(set.id, id, set.exerciseId, set.weightKg, set.reps, set.completedAt,
          previous?.kind ?? set.kind ?? 'working', set.rpeNamed ? set.rpe : previous?.rpe ?? null, set.note ?? previous?.note ?? '', set.setNumber);
        return new Valid(value, loaded.moment).value;
      });
      const session = loaded.session(id);
      const predicted = session === null ? null : new SessionValue(id, startedAt, finishedAt, 'finish', session.routineId,
        session.historyRoutineId, session.plan, routineName);
      const command = { name: 'gym.correctSession', args: { sessionId: id.json, requestId, startedAt: startedAt.ms,
        finishedAt: finishedAt.ms, routineName, sets: corrected.map((set) => set.json), ...(preserveOtherSets ? { preserveOtherSets: true } : {}) },
      specs: CommandSpecs.filter((spec) => spec.path.startsWith('gym.correctSession.')) };
      const predictions = [
        ...(predicted === null ? [] : [Prediction.update(id, predicted.fields())]),
        ...checked.map((set) => old.some((prior) => prior.id.equals(set.id)) ? Prediction.update(set.id, set.fields()) : Prediction.create(set.id, set.fields())),
        ...(preserveOtherSets ? [] : old.filter((prior) => !checked.some((set) => set.id.equals(prior.id))).map((set) => Prediction.remove(set.id))),
      ];
      return Decision.write(Plan.running(command, predictions), null);
    },
  });
}
