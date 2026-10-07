// @ts-check

import { Decision } from '../../../platform/domain-kit/actions.js';
import { EntityType, Id, compareText } from '../../../platform/domain-kit/entities.js';
import { Plan } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Check, Valid } from '../../../platform/domain-kit/validation.js';
import { Path } from '../../../platform/domain-kit/values.js';
import { ExerciseRules, GymRefusals } from './gymRules.js';
import { SeedExercises } from './seedExercises.js';

export class ExerciseValue {
  /**
   * @param {Id<ExerciseValue>} id
   * @param {string} name
   * @param {string} pattern
   * @param {string} equipment
   * @param {number} stepKg
   * @param {readonly string[]} aliases
   */
  constructor(id, name, pattern, equipment, stepKg, aliases = []) {
    this.id = id;
    this.name = name;
    this.pattern = pattern;
    this.equipment = equipment;
    this.stepKg = stepKg;
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
   */
  constructor(id, name = null, aliases = []) {
    this.id = id;
    this.name = name;
    this.aliases = Object.freeze([...aliases]);
    Object.freeze(this);
  }

  fields() { return { name: this.name }; }
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
      value.pattern, value.equipment, value.stepKg, value.aliases)),
    new Check('pattern', (value) => new ExerciseValue(value.id, value.name, ExerciseRules.pattern.apply(value.pattern, new Path('pattern')),
      value.equipment, value.stepKg, value.aliases)),
    new Check('equipment', (value) => new ExerciseValue(value.id, value.name, value.pattern,
      ExerciseRules.equipment.apply(value.equipment, new Path('equipment')), value.stepKg, value.aliases)),
    new Check('stepKg', (value) => new ExerciseValue(value.id, value.name, value.pattern, value.equipment,
      ExerciseRules.stepKg.apply(value.stepKg, new Path('stepKg')), value.aliases)),
  ],
});

/** @type {EntityType<ExerciseNameValue>} */
export const ExerciseName = new EntityType({
  type: 'exerciseName', scope: 'self/gym',
  decode: (f) => new ExerciseNameValue(new Id(f.id, ExerciseName), f.optionalString('name'), aliasesOf(f)),
  checks: [new Check('name', (value) => new ExerciseNameValue(value.id,
    ExerciseRules.seedName.applyOptional(value.name, new Path('name')), value.aliases))],
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
  /**
   * @param {import('../../../platform/domain-kit/reading.js').Reader} read
   * @param {import('../../../platform/domain-kit/reading.js').ViewMode} view
   */
  constructor(read, view = 'drawn') {
    const names = read.repository(ExerciseName).all(view);
    const seeds = SeedExercises.all.map((seed) => {
      const named = names.find((value) => value.id.record === seed.id.record);
      return named === undefined ? seed : new ExerciseValue(seed.id, named.name ?? seed.name,
        seed.pattern, seed.equipment, seed.stepKg, named.aliases);
    });
    this.exercises = Object.freeze([...seeds, ...read.repository(Exercise).all(view)]
      .sort((a, b) => compareText(a.name, b.name) || Id.compare(a.id, b.id)));
    Object.freeze(this);
  }

  /** @param {Id<ExerciseValue>} id */
  find(id) { return this.exercises.find((value) => value.id.equals(id)) ?? null; }

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
  load(read) { return { exercise: new Catalogue(read, 'stored').find(this.id), moment: read.moment }; }

  /** @param {{ exercise: ExerciseValue | null, moment: import('../../../platform/domain-kit/time.js').Moment }} loaded */
  decide(loaded) {
    const old = loaded.exercise;
    if (old === null) return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-record', this.id.ref, null, 'predicted')));
    const name = ExerciseRules.name.apply(this.name, new Path('name'));
    if (old.name === name) return Decision.unchanged(null);
    const plan = new Plan();
    if (SeedExercises.all.some((seed) => seed.id.equals(this.id))) {
      plan.create(new Valid(new ExerciseNameValue(new Id(this.id.record, ExerciseName), name), loaded.moment));
    } else {
      plan.update(new Valid(new ExerciseValue(old.id, name, old.pattern, old.equipment, old.stepKg, old.aliases), loaded.moment, ['name']));
    }
    return Decision.write(plan, null);
  }
}
