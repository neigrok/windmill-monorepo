// @ts-check

import { Decision } from '../../../platform/domain-kit/actions.js';
import { SaveDraft } from '../../../platform/domain-kit/drafts.js';
import { EntityType, Fields, Id } from '../../../platform/domain-kit/entities.js';
import { Plan } from '../../../platform/domain-kit/plans.js';
import { Remove } from '../../../platform/domain-kit/standardActions.js';
import { Check, Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation, precondition } from '../../../platform/domain-kit/values.js';
import { Exercise } from './catalogue.js';
import { GymRefusals, RoutineRules } from './gymRules.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('./catalogue.js').ExerciseValue} ExerciseValue */
/** @typedef {{ exerciseId: string, kind: string, reps: number | null, weightKg: number | null, completedAt: number, setNumber?: number | null }} PerformedSet */

export class SetTarget {
  /** @param {number | null} reps @param {number | null} weightKg */
  constructor(reps = null, weightKg = null) {
    this.reps = reps;
    this.weightKg = weightKg;
    Object.freeze(this);
  }

  /** @param {Fields} fields */
  static decode(fields) { return new SetTarget(fields.optionalInt('reps'), fields.optionalDouble('weightKg')); }

  /** @param {number | null} reps @param {number | null} weightKg */
  static clampingReps(reps = null, weightKg = null) {
    const bounded = reps === null ? null : Math.min(RoutineRules.targets.reps.max, Math.max(RoutineRules.targets.reps.min, reps));
    return new SetTarget(bounded, weightKg);
  }

  /** @returns {Record<string, Json>} */
  get json() {
    return { ...(this.reps === null ? {} : { reps: this.reps }), ...(this.weightKg === null ? {} : { weightKg: this.weightKg }) };
  }

  /** @param {Path} path */
  validated(path) {
    if (this.reps === 0) throw new Violation('routine.zeroTarget', path.plus('reps'), { kind: 'custom', custom: 'zeroTarget' });
    const reps = RoutineRules.targets.reps.applyOptional(this.reps, path.plus('reps'));
    const weightKg = RoutineRules.targets.weight.applyOptional(this.weightKg, path.plus('weightKg'));
    if (weightKg === 0 && this.weightKg !== 0) {
      throw new Violation('routine.zeroTarget', path.plus('weightKg'), { kind: 'custom', custom: 'zeroTarget' });
    }
    return new SetTarget(reps, weightKg);
  }
}

export class RoutineEntry {
  /** @param {Id<ExerciseValue>} exerciseId @param {readonly SetTarget[] | null} sets @param {number | null} restSeconds */
  constructor(exerciseId, sets = null, restSeconds = null) {
    this.exerciseId = exerciseId;
    this.sets = sets === null ? null : Object.freeze([...sets]);
    this.restSeconds = restSeconds;
    Object.freeze(this);
  }

  /** @param {Fields} fields */
  static decode(fields) {
    return new RoutineEntry(fields.ref('exerciseId', Exercise), fields.optionalList('sets', SetTarget.decode), fields.optionalInt('restSeconds'));
  }

  /** @returns {Record<string, Json>} */
  get json() {
    return { exerciseId: this.exerciseId.json, ...(this.sets === null ? {} : { sets: this.sets.map((set) => set.json) }),
      ...(this.restSeconds === null ? {} : { restSeconds: this.restSeconds }) };
  }

  get isOpen() { return this.sets === null; }

  /** @param {Path} path */
  validated(path) {
    RoutineRules.exercise.apply(typeof this.exerciseId.record === 'string' ? this.exerciseId.record : '', path.plus('exerciseId'));
    return new RoutineEntry(this.exerciseId,
      RoutineRules.targets.sets.applyOptional(this.sets === null ? null : [...this.sets], path.plus('sets')),
      RoutineRules.targets.rest.applyOptional(this.restSeconds, path.plus('restSeconds')));
  }
}

export class RoutineValue {
  /**
   * @param {Id<RoutineValue>} id
   * @param {string} name
   * @param {number} position
   * @param {readonly RoutineEntry[]} entries
   * @param {number | null} revision
   * @param {number | null} createdEntries
   * @param {string | null} createdDoor
   */
  constructor(id, name = '', position = 0, entries = [], revision = null, createdEntries = null, createdDoor = null) {
    this.id = id;
    this.name = name;
    this.position = position;
    this.entries = Object.freeze([...entries]);
    this.revision = revision;
    this.createdEntries = createdEntries;
    this.createdDoor = createdDoor;
    Object.freeze(this);
  }

  fields() { return { name: this.name, position: this.position, entries: this.entries.map((entry) => entry.json) }; }

  /** @param {readonly RoutineValue[]} routines */
  static ordered(routines) {
    return Object.freeze([...routines].sort((a, b) => a.position - b.position || Id.compare(a.id, b.id)));
  }

  /** @param {{ id: Id<RoutineValue>, name: string, position?: number, sets: readonly PerformedSet[] }} input */
  static fromSession({ id, name, position = 0, sets }) {
    /** @type {Map<string, PerformedSet[]>} */
    const groups = new Map();
    const working = sets.filter((set) => set.kind === 'working').sort((a, b) => a.completedAt - b.completedAt);
    for (const set of working) {
      const group = groups.get(set.exerciseId);
      if (group) group.push(set);
      else groups.set(set.exerciseId, [set]);
    }
    const entries = [...groups].map(([exerciseId, performed]) => {
      const ordered = performed.sort((a, b) => (a.setNumber ?? Number.MAX_SAFE_INTEGER) - (b.setNumber ?? Number.MAX_SAFE_INTEGER)
        || a.completedAt - b.completedAt);
      return new RoutineEntry(new Id(exerciseId, Exercise), ordered.slice(0, RoutineRules.targets.sets.max).map((set) =>
        SetTarget.clampingReps(set.reps, set.weightKg)));
    });
    return new RoutineValue(id, name, position, entries);
  }
}

/** @type {EntityType<RoutineValue>} */
export const Routine = new EntityType({
  type: 'routine', scope: 'self/gym', savesGuarded: true, heldRemoval: true,
  decode: (fields) => new RoutineValue(new Id(fields.id, Routine), fields.string('name'), fields.optionalInt('position') ?? 0,
    fields.list('entries', RoutineEntry.decode), fields.optionalInt('revision'), fields.optionalInt('createdEntries'), fields.optionalString('createdDoor')),
  checks: [
    new Check('name', (value) => new RoutineValue(value.id, RoutineRules.name.apply(value.name, new Path('name')),
      value.position, value.entries, value.revision, value.createdEntries, value.createdDoor)),
    new Check('position', (value) => new RoutineValue(value.id, value.name, RoutineRules.position.apply(value.position, new Path('position')),
      value.entries, value.revision, value.createdEntries, value.createdDoor)),
    new Check('entries', (value) => new RoutineValue(value.id, value.name, value.position,
      RoutineRules.entries.apply([...value.entries], new Path('entries')), value.revision, value.createdEntries, value.createdDoor)),
  ],
});

export class PlanSnapshot {
  /** @param {string} routine @param {readonly RoutineEntry[]} entries */
  constructor(routine, entries) {
    this.routine = routine;
    this.entries = Object.freeze([...entries]);
    Object.freeze(this);
  }

  /** @param {RoutineValue} routine */
  static fromRoutine(routine) { return new PlanSnapshot(routine.name, routine.entries); }

  /** @param {Json | undefined} json */
  static decode(json) {
    if (json === undefined || json === null) return null;
    const fields = Fields.object(json);
    return new PlanSnapshot(fields.string('routine', ''), fields.optionalList('entries', RoutineEntry.decode) ?? []);
  }

  get json() { return { routine: this.routine, entries: this.entries.map((entry) => entry.json) }; }
}

/** @param {import('../../../platform/domain-kit/drafts.js').Draft<RoutineValue>} draft */
export function SaveRoutine(draft) { return SaveDraft.ofDraft(draft, GymRefusals); }

/** @param {Id<RoutineValue>} id */
export function DeleteRoutine(id) { return new Remove(id, GymRefusals); }

/** @param {readonly Id<RoutineValue>[]} order */
export function ReorderRoutines(order) {
  const requested = Object.freeze([...order]);
  return Object.freeze({
    scope: Routine.scope,
    refusals: GymRefusals,
    /** @param {import('../../../platform/domain-kit/reading.js').Reader} read */
    load(read) { return { routines: read.repository(Routine).all('stored'), moment: read.moment }; },
    /** @param {{ routines: RoutineValue[], moment: import('../../../platform/domain-kit/time.js').Moment }} loaded */
    decide({ routines, moment }) {
      if (requested.length !== routines.length || requested.some((id, index) =>
        requested.slice(0, index).some((before) => id.equals(before)) || !routines.some((routine) => id.equals(routine.id)))) {
        throw new Violation('routine.order', new Path('order'), { kind: 'custom', custom: 'notPermutation' });
      }
      const plan = new Plan();
      for (const [position, id] of requested.entries()) {
        const routine = routines.find((value) => value.id.equals(id));
        precondition(routine !== undefined, 'a reorder names every routine');
        if (routine.position === position) continue;
        const moved = new RoutineValue(routine.id, routine.name, position, routine.entries, routine.revision, routine.createdEntries, routine.createdDoor);
        plan.update(new Valid(moved, moment, ['position']));
      }
      return plan.operations.length === 0 ? Decision.unchanged(null) : Decision.write(plan, null);
    },
  });
}
