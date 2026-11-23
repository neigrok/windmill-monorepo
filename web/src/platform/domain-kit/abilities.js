// @ts-check

import { jcs } from '../../../../packages/api-contract/sync/reference/core/jcs.js';

/** @typedef {{ path: string, reason: string }} SchemaFault */

/** @param {unknown} value @param {string[]} required @param {string[]} [optional] @returns {asserts value is Record<string, unknown>} */
function fields(value, required, optional = []) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new TypeError('invalid catalog');
}

export class Ability {
  /** @param {unknown} entry */
  constructor(entry) {
    fields(entry, ['name', 'description', 'input', 'result', 'class', 'agent', 'seats', 'phrase', 'ui'], ['declared', 'since', 'strict']);
    if (typeof entry.name !== 'string' || typeof entry.class !== 'string' || !['read', 'add', 'change', 'remove'].includes(entry.class)
      || typeof entry.agent !== 'string' || !['runs', 'proposes', 'withheld'].includes(entry.agent)
      || typeof entry.seats !== 'string' || !['any', 'bound'].includes(entry.seats)
      || typeof entry.phrase !== 'string' || (entry.declared !== undefined && typeof entry.declared !== 'boolean')
      || (entry.strict !== undefined && typeof entry.strict !== 'boolean')
      || (entry.since !== undefined && (typeof entry.since !== 'string' || !entry.since.startsWith('catalog/')))) throw new TypeError('invalid ability');
    this.name = entry.name;
    this.kind = entry.class;
    this.agent = entry.agent;
    this.seats = entry.seats;
    this.declared = entry.declared ?? true;
    // Whether a turn declares the tool strict to the provider; a catalog that does not say holds every tool strict.
    this.strict = entry.strict ?? true;
    this.phrase = entry.phrase;
    this.input = structuredClone(entry.input);
    this.result = structuredClone(entry.result);
  }

  /** @param {string} seat */
  admits(seat) { return this.seats === 'any' || seat === 'bound'; }
}

export class Catalog {
  /** @param {unknown} catalog */
  constructor(catalog) {
    fields(catalog, ['catalog', 'abilities']);
    if (typeof catalog.catalog !== 'string' || !Array.isArray(catalog.abilities)) throw new TypeError('invalid catalog');
    this.version = catalog.catalog;
    this.abilities = catalog.abilities.map((entry) => new Ability(entry));
    if (new Set(this.abilities.map((ability) => ability.name)).size !== this.abilities.length) throw new TypeError('duplicate-ability');
  }

  /** @param {string} name */
  ability(name) { return this.abilities.find((ability) => ability.name === name) ?? null; }
  /** @param {string} seat */
  offered(seat) { return this.abilities.filter((ability) => ability.agent !== 'withheld' && ability.declared && ability.admits(seat)); }
}

export class JsonSchema {
  /** @param {unknown} schema */
  constructor(schema) { this.schema = schema; }

  /** @param {unknown} value @param {unknown} [schema] @param {string} [path] @returns {SchemaFault | null} */
  fault(value, schema = this.schema, path = '') {
    if (!schema || Array.isArray(schema) || typeof schema !== 'object') return null;
    const rules = /** @type {Record<string, unknown>} */ (schema);
    /** @param {string} reason @param {string} [child] */
    const fault = (reason, child = path) => ({ path: child, reason });
    /** @param {string | number} key */
    const child = (key) => path ? `${path}.${key}` : String(key);
    /** @param {unknown} n @returns {n is number} */
    const integer = (n) => typeof n === 'number' && Number.isInteger(n) && n > -9223372036854775808 && n < 9223372036854775807;
    const object = value !== null && typeof value === 'object' && !Array.isArray(value);
    /** @param {unknown} type @returns {boolean} */
    const matches = (type) => {
      if (Array.isArray(type)) return type.some(matches);
      const types = /** @type {Record<string, boolean>} */ ({ object, array: Array.isArray(value), string: typeof value === 'string', boolean: typeof value === 'boolean',
        null: value === null, number: typeof value === 'number', integer: typeof value === 'number' && Number.isInteger(value) });
      return types[String(type)] === true;
    };
    if (Object.hasOwn(rules, 'type') && !matches(rules.type)) return fault(`not ${jcs(rules.type)}`);
    if (Array.isArray(rules.enum) && !rules.enum.some((item) => jcs(item) === jcs(value))) return fault('not one of the enum');
    if (Object.hasOwn(rules, 'const') && jcs(rules.const) !== jcs(value)) return fault('not the constant');
    if (object) {
      const members = /** @type {Record<string, unknown>} */ (value);
      const properties = /** @type {Record<string, unknown>} */ (rules.properties && typeof rules.properties === 'object' && !Array.isArray(rules.properties) ? rules.properties : {});
      for (const name of Array.isArray(rules.required) ? rules.required : []) {
        if (typeof name === 'string' && !Object.hasOwn(members, name)) return fault('required', child(name));
      }
      if (rules.additionalProperties === false) for (const name of Object.keys(members).sort()) {
        if (!Object.hasOwn(properties, name)) return fault('not a property', child(name));
      }
      for (const name of Object.keys(properties).sort()) {
        if (!Object.hasOwn(members, name)) continue;
        const error = this.fault(members[name], properties[name], child(name));
        if (error) return error;
      }
    } else if (Array.isArray(value)) {
      if (integer(rules.minItems) && value.length < rules.minItems) return fault(`fewer than ${rules.minItems} items`);
      if (integer(rules.maxItems) && value.length > rules.maxItems) return fault(`more than ${rules.maxItems} items`);
      if (rules.uniqueItems === true) {
        const seen = new Set();
        for (const [index, item] of value.entries()) {
          const key = jcs(item);
          if (seen.has(key)) return fault('repeats an item', child(index));
          seen.add(key);
        }
      }
      if (Object.hasOwn(rules, 'items')) for (const [index, item] of value.entries()) {
        const error = this.fault(item, rules.items, child(index));
        if (error) return error;
      }
    } else if (typeof value === 'string') {
      const length = [...value].length;
      if (integer(rules.minLength) && length < rules.minLength) return fault(`shorter than ${rules.minLength}`);
      if (integer(rules.maxLength) && length > rules.maxLength) return fault(`longer than ${rules.maxLength}`);
      if (typeof rules.pattern === 'string') {
        try {
          const pattern = new RegExp(rules.pattern, 'u').source;
          if (!new RegExp(`^(?:${pattern})(?![\\s\\S])`, 'u').test(value)) return fault(`not ${rules.pattern}`);
        } catch { return fault(`not ${rules.pattern}`); }
      }
    } else if (typeof value === 'number') {
      if (typeof rules.minimum === 'number' && value < rules.minimum) return fault(`below ${jcs(rules.minimum)}`);
      if (typeof rules.maximum === 'number' && value > rules.maximum) return fault(`above ${jcs(rules.maximum)}`);
    }
    return null;
  }
}
