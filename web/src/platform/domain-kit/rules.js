// @ts-check
// §6.3 the rule book: a product's LOCAL and SERVER-DECIDED rules and its entities' facts, pinned byte
// for byte across the kits by `packages/api-contract/<product>/domain/rules.json`.

import { compareText } from './entities.js';

/** @typedef {import('./values.js').Json} Json */
/** @typedef {import('./values.js').ValueSpec} ValueSpec */
/** @typedef {import('./entities.js').EntityType<any>} AnyEntityType */
/** @typedef {import('../../../../packages/api-contract/sync/reference/core/registry.js').Registry} Registry */

export class Rule {
  /**
   * @param {string} name
   * @param {string} subject
   * @param {'local' | 'serverDecided'} kind
   * @param {string[]} codes
   * @param {Json | null} spec
   */
  constructor(name, subject, kind, codes, spec) {
    this.name = name;
    this.subject = subject;
    this.kind = kind;
    this.codes = Object.freeze([...codes]);
    this.spec = spec;
    Object.freeze(this);
  }

  // A LOCAL rule declared as a value spec, named by the spec's registry path.
  /** @param {ValueSpec} spec */
  static localSpec(spec) {
    return new Rule(spec.path, spec.path.split('.')[0] ?? spec.path, 'local', [], spec.json);
  }

  // A LOCAL rule written as code, with the codes its server half refuses with.
  /**
   * @param {string} name
   * @param {string} subject
   * @param {string[]} backstop
   */
  static localCheck(name, subject, backstop = []) {
    return new Rule(name, subject, 'local', backstop, null);
  }

  /**
   * @param {string} name
   * @param {string[]} codes
   * @param {string} subject
   */
  static serverDecided(name, codes, subject) {
    return new Rule(name, subject, 'serverDecided', codes, null);
  }

  /** @returns {Json} */
  get json() {
    /** @type {{[key: string]: Json}} */
    const json = { name: this.name, subject: this.subject, kind: this.kind === 'local' ? 'local' : 'server' };
    if (this.spec !== null) json.spec = this.spec;
    if (this.codes.length) json.codes = [...this.codes];
    return json;
  }
}

export class RuleBook {
  /**
   * @param {Registry} registry
   * @param {AnyEntityType[]} entities
   * @param {Rule[]} rules
   */
  constructor(registry, entities, rules) {
    this.registry = registry;
    this.entities = Object.freeze([...entities].sort((a, b) => compareText(a.type, b.type)));
    this.rules = Object.freeze([...rules, ...this.entities.flatMap((entity) => RuleBook.standardRules(entity, registry))]
      .sort((a, b) => compareText(a.name, b.name)));
    Object.freeze(this);
  }

  /** @param {string} type */
  entity(type) {
    return this.entities.find((entity) => entity.type === type) ?? null;
  }

  /** @returns {Json} */
  get json() {
    return {
      entities: this.entities.map((entity) => {
        /** @type {{[key: string]: Json}} */
        const facts = {
          type: entity.type,
          removable: entity.isRemovable,
          held: entity.heldRemoval === true,
          ordered: entity.isOrdered,
          guarded: entity.savesGuarded === true,
        };
        if (entity.timestampField !== null) facts.timestamp = entity.timestampField;
        return facts;
      }),
      rules: this.rules.map((rule) => rule.json),
    };
  }

  // The standard rules every entity brings: gone for a type with life, taken for a minted type, stale
  // for a guarded save, cap for a capped type, size for a type with a text field.
  /**
   * @param {AnyEntityType} entity
   * @param {Registry} registry
   */
  static standardRules(entity, registry) {
    const definition = registry.type(entity.type);
    if (!definition) return [];
    /** @type {[boolean, string, string[]][]} */
    const standard = [
      [definition.life === true, 'gone', ['unknown-record', 'record-dead']],
      [definition.identity === 'minted', 'taken', ['id-taken', 'id-spent']],
      [entity.savesGuarded === true, 'stale', ['stale']],
      [definition.cap !== undefined, 'cap', ['cap']],
      [definition.textFieldNames.length > 0, 'size', ['too-large']],
    ];
    return standard.filter(([applies]) => applies)
      .map(([, name, codes]) => Rule.serverDecided(`${entity.type}.${name}`, codes, entity.type));
  }
}
