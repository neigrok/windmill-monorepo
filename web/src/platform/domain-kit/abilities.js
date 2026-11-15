import { jcs } from '../../../../packages/api-contract/sync/reference/core/jcs.js';

function fields(value, required, optional = []) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) throw new TypeError('invalid catalog');
}

export class Ability {
  constructor(entry) {
    fields(entry, ['name', 'description', 'input', 'result', 'class', 'agent', 'seats', 'phrase', 'ui'], ['declared', 'since']);
    if (typeof entry.name !== 'string' || !['read', 'add', 'change', 'remove'].includes(entry.class)
      || !['runs', 'proposes', 'withheld'].includes(entry.agent) || !['any', 'bound'].includes(entry.seats)
      || typeof entry.phrase !== 'string' || (entry.declared !== undefined && typeof entry.declared !== 'boolean')
      || (entry.since !== undefined && (typeof entry.since !== 'string' || !entry.since.startsWith('catalog/')))) throw new TypeError('invalid ability');
    Object.assign(this, { name: entry.name, kind: entry.class, agent: entry.agent, seats: entry.seats,
      declared: entry.declared ?? true, phrase: entry.phrase, input: structuredClone(entry.input), result: structuredClone(entry.result) });
  }

  admits(seat) { return this.seats === 'any' || seat === 'bound'; }
}

export class Catalog {
  constructor(document) {
    fields(document, ['catalog', 'abilities']);
    if (typeof document.catalog !== 'string' || !Array.isArray(document.abilities)) throw new TypeError('invalid catalog');
    this.version = document.catalog;
    this.abilities = document.abilities.map((entry) => new Ability(entry));
    if (new Set(this.abilities.map((ability) => ability.name)).size !== this.abilities.length) throw new TypeError('duplicate-ability');
  }

  ability(name) { return this.abilities.find((ability) => ability.name === name) ?? null; }
  offered(seat) { return this.abilities.filter((ability) => ability.agent !== 'withheld' && ability.declared && ability.admits(seat)); }
}

export class JsonSchema {
  constructor(schema) { this.schema = schema; }

  fault(value, schema = this.schema, path = '') {
    if (!schema || Array.isArray(schema) || typeof schema !== 'object') return null;
    const fault = (reason, child = path) => ({ path: child, reason });
    const child = (key) => path ? `${path}.${key}` : String(key);
    const integer = (n) => typeof n === 'number' && Number.isInteger(n) && n > -9223372036854775808 && n < 9223372036854775807;
    const object = value !== null && typeof value === 'object' && !Array.isArray(value);
    const matches = (type) => {
      if (Array.isArray(type)) return type.some(matches);
      return ({ object, array: Array.isArray(value), string: typeof value === 'string', boolean: typeof value === 'boolean',
        null: value === null, number: typeof value === 'number', integer: typeof value === 'number' && Number.isInteger(value) })[type] === true;
    };
    if (Object.hasOwn(schema, 'type') && !matches(schema.type)) return fault(`not ${jcs(schema.type)}`);
    if (Array.isArray(schema.enum) && !schema.enum.some((item) => jcs(item) === jcs(value))) return fault('not one of the enum');
    if (Object.hasOwn(schema, 'const') && jcs(schema.const) !== jcs(value)) return fault('not the constant');
    if (object) {
      const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties : {};
      for (const name of Array.isArray(schema.required) ? schema.required : []) {
        if (typeof name === 'string' && !Object.hasOwn(value, name)) return fault('required', child(name));
      }
      if (schema.additionalProperties === false) for (const name of Object.keys(value).sort()) {
        if (!Object.hasOwn(properties, name)) return fault('not a property', child(name));
      }
      for (const name of Object.keys(properties).sort()) {
        if (!Object.hasOwn(value, name)) continue;
        const error = this.fault(value[name], properties[name], child(name));
        if (error) return error;
      }
    } else if (Array.isArray(value)) {
      if (integer(schema.minItems) && value.length < schema.minItems) return fault(`fewer than ${schema.minItems} items`);
      if (integer(schema.maxItems) && value.length > schema.maxItems) return fault(`more than ${schema.maxItems} items`);
      if (schema.uniqueItems === true) {
        const seen = new Set();
        for (const [index, item] of value.entries()) {
          const key = jcs(item);
          if (seen.has(key)) return fault('repeats an item', child(index));
          seen.add(key);
        }
      }
      if (Object.hasOwn(schema, 'items')) for (const [index, item] of value.entries()) {
        const error = this.fault(item, schema.items, child(index));
        if (error) return error;
      }
    } else if (typeof value === 'string') {
      const length = [...value].length;
      if (integer(schema.minLength) && length < schema.minLength) return fault(`shorter than ${schema.minLength}`);
      if (integer(schema.maxLength) && length > schema.maxLength) return fault(`longer than ${schema.maxLength}`);
      if (typeof schema.pattern === 'string') {
        try {
          const match = new RegExp(`(?:${schema.pattern})`, 'u').exec(value);
          if (!match || match.index !== 0 || match[0].length !== value.length) return fault(`not ${schema.pattern}`);
        } catch { return fault(`not ${schema.pattern}`); }
      }
    } else if (typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum) return fault(`below ${jcs(schema.minimum)}`);
      if (typeof schema.maximum === 'number' && value > schema.maximum) return fault(`above ${jcs(schema.maximum)}`);
    }
    return null;
  }
}
