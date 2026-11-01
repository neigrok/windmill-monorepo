// @ts-check

import { Decision } from '../../../platform/domain-kit/actions.js';
import { SaveDraft } from '../../../platform/domain-kit/drafts.js';
import { EntityType, Fields, Id, sameJson, uniqueInByteOrder } from '../../../platform/domain-kit/entities.js';
import { Plan } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Remove } from '../../../platform/domain-kit/standardActions.js';
import { Check, Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation, precondition } from '../../../platform/domain-kit/values.js';
import { setOwn } from '../../../../../packages/api-contract/sync/reference/core/maps.js';
import { Catalogue, Exercise, ExerciseName, ExerciseNameValue, ExerciseValue, renamedAliases } from './catalogue.js';
import { GymRefusals, RoutineRules } from './gymRules.js';
import { SeedExercises } from './seedExercises.js';
import { inLoggedOrder } from './training.js';
import { WeightLadder } from './units.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {{ base: ExerciseValue | null, current: ExerciseValue }} RoutineMovementChange */
/** @typedef {{ id?: string, exerciseId: string, reps: number | null, weightKg: number | null, completedAt: number }} PerformedSet */

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
    if (reps === null) return new SetTarget(null, weightKg);
    const { min, max } = RoutineRules.targets.reps;
    precondition(min !== undefined && max !== undefined, 'routine target reps have both count bounds');
    return new SetTarget(Math.min(max, Math.max(min, reps)), weightKg);
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

  // A straight scheme is one whose sets all agree, loads read on the ladder's grid; an open line is straight.
  /** @param {readonly SetTarget[]} sets */
  static straight(sets) {
    /** @param {number | null} weightKg */
    const onGrid = (weightKg) => weightKg === null ? null : WeightLadder.round(weightKg);
    return sets.every((set) => set.reps === sets[0]?.reps && onGrid(set.weightKg) === onGrid(sets[0]?.weightKg ?? null));
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
    for (const set of [...sets].sort(inLoggedOrder)) {
      const group = groups.get(set.exerciseId);
      if (group) group.push(set);
      else groups.set(set.exerciseId, [set]);
    }
    const entries = [...groups].map(([exerciseId, performed]) => new RoutineEntry(new Id(exerciseId, Exercise),
      performed.slice(0, RoutineRules.targets.sets.max).map((set) => SetTarget.clampingReps(set.reps, set.weightKg))));
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

export class SaveRoutinePlan {
  /** @param {RoutineValue} base @param {RoutineValue} current @param {boolean} isNew @param {readonly RoutineMovementChange[]} movements */
  constructor(base, current, isNew, movements) {
    precondition(base.id.equals(current.id), 'a routine plan edits its own record');
    for (const movement of movements) {
      precondition(movement.base === null || movement.base.id.equals(movement.current.id), 'a movement edit keeps its identity');
    }
    this.base = base;
    this.current = current;
    this.isNew = isNew;
    this.movements = Object.freeze(movements.map((movement) => Object.freeze({ ...movement })));
    this.scope = Routine.scope;
    this.refusals = GymRefusals;
    Object.freeze(this);
  }

  /** @param {import('../../../platform/domain-kit/reading.js').Reader} read */
  load(read) {
    const repository = read.repository(Routine);
    return {
      routine: repository.find(this.current.id, 'stored'),
      visible: repository.find(this.current.id, 'drawn') !== null,
      catalogue: new Catalogue(read, 'stored'),
      visibleExercises: new Catalogue(read).exercises.map((exercise) => exercise.id),
      formerNames: Fields.object(read.device(Catalogue.formerNamesKey) ?? {}).values,
      moment: read.moment,
    };
  }

  /** @param {ReturnType<SaveRoutinePlan['load']>} loaded */
  decide(loaded) {
    const { base, current, isNew } = this;
    if (isNew && loaded.routine !== null) {
      return Decision.refuse(GymRefusals.ofRefused(new Refused('id-taken', current.id.ref, null, 'predicted')));
    }
    if (!isNew && (!loaded.visible || loaded.routine === null)) {
      return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-record', current.id.ref, null, 'predicted')));
    }
    /** @type {Record<string, Json>} */
    const baseFields = base.fields();
    /** @type {Record<string, Json>} */
    const currentFields = current.fields();
    const touched = uniqueInByteOrder(Object.keys(currentFields)).filter((field) => isNew || !sameJson(currentFields[field], baseFields[field]));
    const valid = new Valid(current, loaded.moment, touched);
    this.floor(valid.value, loaded.catalogue);
    /** @type {Record<string, Json> | undefined} */
    const storedFields = loaded.routine?.fields();
    const changed = touched.filter((field) => !sameJson(storedFields?.[field], valid.written[field]));
    if (!isNew && changed.some((field) => !sameJson(storedFields?.[field], baseFields[field]))) {
      return Decision.refuse(GymRefusals.ofRefused(new Refused('stale', current.id.ref, null, 'predicted')));
    }
    const plan = new Plan();
    if (isNew) plan.create(valid);
    else if (changed.length) plan.update(valid, { fields: changed, from: base, guarded: true });
    let wrote = isNew || changed.length > 0;
    const former = { ...loaded.formerNames };
    const edits = this.movements.filter((edit) => current.entries.some((entry) => entry.exerciseId.equals(edit.current.id)))
      .sort((a, b) => Id.compare(a.current.id, b.current.id));
    precondition(edits.every((edit, index) => !edits.slice(0, index).some((previous) => edit.current.id.equals(previous.current.id))),
      'a routine plan edits each included movement once');
    for (const edit of edits) {
      const next = new Valid(edit.current, loaded.moment).value;
      const before = edit.base;
      if (before === null) {
        if (loaded.catalogue.find(next.id) !== null) {
          return Decision.refuse(GymRefusals.ofRefused(new Refused('id-taken', next.id.ref, null, 'predicted')));
        }
        plan.create(new Valid(next, loaded.moment));
        if (next.equipment === 'dumbbell' && next.loadCount !== ExerciseValue.pairedLoadCount) {
          const metadata = new ExerciseNameValue(new Id(next.id.record, ExerciseName), null, [], null, next.loadCount);
          plan.create(new Valid(metadata, loaded.moment), { fields: ['loadCount'] });
        }
        wrote = true;
        continue;
      }
      const stored = loaded.catalogue.find(next.id);
      if (stored === null || !loaded.visibleExercises.some((id) => id.equals(next.id))) {
        return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-record', next.id.ref, null, 'predicted')));
      }
      const currentTargets = current.entries.find((entry) => entry.exerciseId.equals(next.id))?.sets?.map((set) => set.json);
      const baseTargets = base.entries.find((entry) => entry.exerciseId.equals(next.id))?.sets?.map((set) => set.json);
      const targetsChanged = !sameJson(currentTargets, baseTargets);
      const unitsChanged = next.equipment !== before.equipment || next.loadCount !== before.loadCount;
      const unitsSettled = next.equipment === stored.equipment && next.loadCount === stored.loadCount;
      if ((targetsChanged || unitsChanged) && !unitsSettled && (stored.equipment !== before.equipment || stored.loadCount !== before.loadCount)) {
        return Decision.refuse(GymRefusals.ofRefused(new Refused('stale', next.id.ref, null, 'predicted')));
      }
      const seed = SeedExercises.has(next.id);
      if (targetsChanged || unitsChanged) {
        plan.guardRead(new Id(next.id.record, ExerciseName), ['equipment', 'loadCount']);
        if (!seed) plan.guardRead(next.id, ['equipment']);
      }
      const renamed = next.name !== before.name && next.name !== stored.name;
      const equipped = next.equipment !== before.equipment && next.equipment !== stored.equipment;
      const counted = next.loadCount !== before.loadCount && next.loadCount !== stored.loadCount;
      if ((renamed && stored.name !== before.name) || (equipped && stored.equipment !== before.equipment)
        || (counted && stored.loadCount !== before.loadCount)) {
        return Decision.refuse(GymRefusals.ofRefused(new Refused('stale', next.id.ref, null, 'predicted')));
      }
      const metadata = new ExerciseNameValue(new Id(next.id.record, ExerciseName), seed && renamed ? next.name : null, [],
        equipped ? next.equipment : null, next.equipment === 'dumbbell' && (equipped || counted) ? next.loadCount : null);
      if (renamed) {
        setOwn(former, String(next.id.record), { name: next.name, aliases: [...renamedAliases(stored.name, next.name, stored.aliases)] });
        if (!seed) {
          const custom = new ExerciseValue(stored.id, next.name, stored.pattern, stored.equipment, stored.stepKg, stored.aliases, stored.loadCount);
          plan.update(new Valid(custom, loaded.moment, ['name']), { from: stored, guarded: true });
        }
        wrote = true;
      }
      const fields = uniqueInByteOrder(Object.keys(metadata.fields()));
      if (fields.length) {
        plan.guardRead(metadata.id, fields);
        plan.create(new Valid(metadata, loaded.moment, fields), { fields });
        wrote = true;
      }
    }
    if (!sameJson(former, loaded.formerNames)) plan.device(Catalogue.formerNamesKey, former);
    return wrote ? Decision.write(plan, current.id) : Decision.unchanged(current.id);
  }

  // A target load meets its movement's floor on each line whose targets or staged movement loading this save changes.
  /** @param {RoutineValue} routine @param {Catalogue} catalogue */
  floor(routine, catalogue) {
    routine.entries.forEach((entry, index) => {
      const staged = this.movements.find((movement) => movement.current.id.equals(entry.exerciseId)) ?? null;
      const before = this.base.entries.find((line) => line.exerciseId.equals(entry.exerciseId));
      const retargeted = !sameJson(before?.sets?.map((set) => set.json) ?? null, entry.sets?.map((set) => set.json) ?? null);
      const reloaded = staged !== null && (staged.base === null || staged.base.equipment !== staged.current.equipment
        || staged.base.loadCount !== staged.current.loadCount);
      if (!retargeted && !reloaded) return;
      const movement = staged?.current ?? catalogue.find(entry.exerciseId);
      if (movement === null) return;
      entry.sets?.forEach((set, at) => {
        if (set.weightKg !== null) movement.floored(set.weightKg, RoutineRules.loadFloor, new Path('entries').plus(index).plus('sets').plus(at).plus('weightKg'));
      });
    });
  }
}

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
