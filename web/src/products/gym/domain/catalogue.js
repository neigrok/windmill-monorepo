// @ts-check

import { Decision } from '../../../platform/domain-kit/actions.js';
import { EntityType, Fields, Id, compareText } from '../../../platform/domain-kit/entities.js';
import { Plan } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Check, Valid } from '../../../platform/domain-kit/validation.js';
import { Path } from '../../../platform/domain-kit/values.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { ExerciseRules, GymRefusals } from './gymRules.js';
import { SeedExercises } from './seedExercises.js';

export class ExerciseValue {
  static pairedLoadCount = 2;

  /**
   * @param {Id<ExerciseValue>} id
   * @param {string} name
   * @param {string} pattern
   * @param {string} equipment
   * @param {number} stepKg
   * @param {readonly string[]} aliases
   * @param {number} loadCount
   */
  constructor(id, name, pattern, equipment, stepKg, aliases = [], loadCount = ExerciseValue.pairedLoadCount) {
    this.id = id;
    this.name = name;
    this.pattern = pattern;
    this.equipment = equipment;
    this.stepKg = stepKg;
    this.loadCount = equipment === 'dumbbell' ? loadCount : 1;
    this.aliases = Object.freeze([...aliases]);
    Object.freeze(this);
  }

  fields() {
    return { name: this.name, pattern: this.pattern, equipment: this.equipment, stepKg: this.stepKg };
  }
}

export class ExerciseNameValue {
  /**
   * @param {Id<ExerciseNameValue>} id
   * @param {string | null} name
   * @param {readonly string[]} aliases
   * @param {string | null} equipment
   * @param {number | null} loadCount
   */
  constructor(id, name = null, aliases = [], equipment = null, loadCount = null) {
    this.id = id;
    this.name = name;
    this.equipment = equipment;
    this.loadCount = loadCount;
    this.aliases = Object.freeze([...aliases]);
    Object.freeze(this);
  }

  fields() {
    return { ...(this.name === null ? {} : { name: this.name }), ...(this.equipment === null ? {} : { equipment: this.equipment }),
      ...(this.loadCount === null ? {} : { loadCount: this.loadCount }) };
  }
}

/** @param {import('../../../platform/domain-kit/entities.js').Fields} fields */
function aliasesOf(fields) {
  const aliases = fields.json('aliases');
  if (aliases === undefined || aliases === null) return [];
  if (!Array.isArray(aliases)) throw fields.failure('aliases', 'not an array');
  return aliases.map((alias, index) => {
    if (typeof alias !== 'string') throw fields.failure(`aliases.${index}`, 'not a string');
    return alias;
  });
}

/** @type {EntityType<ExerciseValue>} */
export const Exercise = new EntityType({
  type: 'exercise', scope: 'self/gym',
  decode: (f) => new ExerciseValue(new Id(f.id, Exercise), f.string('name'), f.string('pattern'),
    f.string('equipment'), f.double('stepKg'), aliasesOf(f)),
  checks: [
    new Check('name', (value) => new ExerciseValue(value.id, ExerciseRules.name.apply(value.name, new Path('name')),
      value.pattern, value.equipment, value.stepKg, value.aliases, value.loadCount)),
    new Check('pattern', (value) => new ExerciseValue(value.id, value.name, ExerciseRules.pattern.apply(value.pattern, new Path('pattern')),
      value.equipment, value.stepKg, value.aliases, value.loadCount)),
    new Check('equipment', (value) => new ExerciseValue(value.id, value.name, value.pattern,
      ExerciseRules.equipment.apply(value.equipment, new Path('equipment')), value.stepKg, value.aliases, value.loadCount)),
    new Check('stepKg', (value) => new ExerciseValue(value.id, value.name, value.pattern, value.equipment,
      ExerciseRules.stepKg.apply(value.stepKg, new Path('stepKg')), value.aliases, value.loadCount)),
  ],
});

/** @type {EntityType<ExerciseNameValue>} */
export const ExerciseName = new EntityType({
  type: 'exerciseName', scope: 'self/gym',
  decode: (f) => new ExerciseNameValue(new Id(f.id, ExerciseName), f.optionalString('name'), aliasesOf(f), f.optionalString('equipment'), f.optionalInt('loadCount')),
  checks: [new Check('name', (value) => new ExerciseNameValue(value.id,
    ExerciseRules.seedName.applyOptional(value.name, new Path('name')), value.aliases, value.equipment, value.loadCount)),
    new Check('equipment', (value) => new ExerciseNameValue(value.id, value.name, value.aliases,
      ExerciseRules.equipmentOverride.applyOptional(value.equipment, new Path('equipment')), value.loadCount)),
    new Check('loadCount', (value) => new ExerciseNameValue(value.id, value.name, value.aliases, value.equipment,
      ExerciseRules.loadCount.applyOptional(value.loadCount, new Path('loadCount'))))],
});

/** @param {string} equipment */
export function defaultStepKg(equipment) {
  switch (equipment) {
    case 'dumbbell': return 2;
    case 'machine': return 5;
    case 'kettlebell': return 4;
    default: return 2.5;
  }
}

/** @param {string} previous @param {string} next @param {readonly string[]} aliases */
export function renamedAliases(previous, next, aliases) {
  return Object.freeze([...new Set([previous, ...aliases].filter((alias) => alias !== next))].slice(0, 5));
}

export class Catalogue {
  static formerNamesKey = 'rack:catalogue';

  /** @type {Map<string, ExerciseValue>} */
  #byId;

  /**
   * @param {import('../../../platform/domain-kit/reading.js').Reader} read
   * @param {import('../../../platform/domain-kit/reading.js').ViewMode} view
   */
  constructor(read, view = 'drawn') {
    const former = Fields.object(read.device(Catalogue.formerNamesKey) ?? {}).values;
    const overrides = new Map(read.repository(ExerciseName).all(view).map((value) => [jcs(value.id.json), value]));
    /** @param {ExerciseValue} exercise @param {boolean} seed */
    const resolved = (exercise, seed) => {
      const override = overrides.get(jcs(exercise.id.json));
      if (!override) return exercise;
      return new ExerciseValue(exercise.id, seed ? override.name ?? exercise.name : exercise.name, exercise.pattern,
        override.equipment ?? exercise.equipment, exercise.stepKg, seed ? override.aliases : exercise.aliases,
        override.loadCount ?? (exercise.equipment === 'dumbbell' ? exercise.loadCount : ExerciseValue.pairedLoadCount));
    };
    this.exercises = Object.freeze([...SeedExercises.all.map((seed) => resolved(seed, true)),
      ...read.repository(Exercise).all(view).map((custom) => resolved(custom, false))].map((exercise) => {
      if (!Object.hasOwn(former, String(exercise.id.record))) return exercise;
      const value = former[String(exercise.id.record)];
      if (value === undefined) return exercise;
      const fields = Fields.object(value);
      if (fields.string('name') !== exercise.name) return exercise;
      const aliases = renamedAliases(exercise.name, exercise.name, [...aliasesOf(fields), ...exercise.aliases]);
      return new ExerciseValue(exercise.id, exercise.name, exercise.pattern, exercise.equipment, exercise.stepKg, aliases, exercise.loadCount);
    })
      .sort((a, b) => compareText(a.name, b.name) || Id.compare(a.id, b.id)));
    this.#byId = new Map(this.exercises.map((exercise) => [jcs(exercise.id.json), exercise]));
    Object.freeze(this);
  }

  /** @param {Id<ExerciseValue>} id */
  find(id) { return id.entity.type === Exercise.type ? this.#byId.get(jcs(id.json)) ?? null : null; }

  /** @param {string} text */
  search(text) {
    const query = text.toLowerCase();
    return Object.freeze(this.exercises.filter((value) => value.name.toLowerCase().includes(query)
      || value.aliases.some((alias) => alias.toLowerCase().includes(query))));
  }
}

export class CreateExercise {
  /** @param {ExerciseValue} value */
  constructor(value) {
    this.value = value;
    this.scope = Exercise.scope;
    this.refusals = GymRefusals;
    Object.freeze(this);
  }

  /** @param {import('../../../platform/domain-kit/reading.js').Reader} read */
  load(read) { return read.moment; }

  /** @param {import('../../../platform/domain-kit/time.js').Moment} loaded */
  decide(loaded) {
    const plan = new Plan();
    plan.create(new Valid(this.value, loaded));
    if (this.value.equipment === 'dumbbell' && this.value.loadCount !== ExerciseValue.pairedLoadCount) {
      plan.create(new Valid(new ExerciseNameValue(new Id(this.value.id.record, ExerciseName), null, [], null, this.value.loadCount), loaded));
    }
    return Decision.write(plan, this.value.id);
  }
}

export class RenameExercise {
  /** @param {Id<ExerciseValue>} id @param {string} name */
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.scope = Exercise.scope;
    this.refusals = GymRefusals;
    Object.freeze(this);
  }

  /** @param {import('../../../platform/domain-kit/reading.js').Reader} read */
  load(read) { return { exercise: new Catalogue(read, 'stored').find(this.id),
    override: read.repository(ExerciseName).find(new Id(this.id.record, ExerciseName), 'stored'), moment: read.moment }; }

  /** @param {{ exercise: ExerciseValue | null, override: ExerciseNameValue | null, moment: import('../../../platform/domain-kit/time.js').Moment }} loaded */
  decide(loaded) {
    const old = loaded.exercise;
    if (old === null) return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-record', this.id.ref, null, 'predicted')));
    const name = ExerciseRules.name.apply(this.name, new Path('name'));
    if (old.name === name) return Decision.unchanged(null);
    const plan = new Plan();
    if (SeedExercises.has(this.id)) {
      const override = new ExerciseNameValue(new Id(this.id.record, ExerciseName), name, old.aliases,
        loaded.override?.equipment ?? null, loaded.override?.loadCount ?? null);
      if (loaded.override) plan.update(new Valid(override, loaded.moment, ['name']));
      else plan.create(new Valid(override, loaded.moment));
    } else {
      plan.update(new Valid(new ExerciseValue(old.id, name, old.pattern, old.equipment, old.stepKg, old.aliases), loaded.moment, ['name']));
    }
    return Decision.write(plan, null);
  }
}
