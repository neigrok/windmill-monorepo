// @ts-check
// §3 entities and records: the declaration an entity's records belong to, its typed id, and the lenient
// reader of one record or one object inside it.

import { compareBytes, utf8 } from '../sync/core/encoding.js';
import { compareJcs, jcs } from '../sync/core/jcs.js';
import { Instant, LocalDay } from './time.js';
import { Fault, precondition } from './values.js';

/** @typedef {import('./values.js').Json} Json */
/** @typedef {string | Json[]} RecordID */
/** @typedef {{ t: string, id: RecordID }} RecordRef */
/**
 * The engine's view record (engine §7.6): lattice registers `[value, stamp]`, texts as plain strings,
 * serials as numbers.
 * @typedef {{ t: string, id: RecordID, life?: [string, string], born?: string, f?: Record<string, [Json, string]>,
 *   x?: Record<string, string>, v?: Record<string, number>, rc?: number }} ViewRecord
 */
/**
 * An entity value: its id, and when written, every client field as JSON.
 * @template E
 * @typedef {{ id: Id<E>, fields(): Record<string, Json> }} Writable
 */
/**
 * A registry type as the kit reads it (ER-16): the engine's TypeDef with the members `Object.assign` gives it.
 * @typedef {import('../sync/core/registry.js').TypeDef & { identity: string, scope: string, life?: boolean, cap?: number,
 *   wholePut?: boolean, singletonId?: RecordID, mint?: { prefix: string, alphabet: string, length: number },
 *   fields: Record<string, { kind: string, writer: string }> }} Definition
 */

export class DecodeError extends Error {
  /**
   * @param {string} type
   * @param {string} field
   * @param {string} reason
   */
  constructor(type, field, reason) {
    super(`${type}.${field}: ${reason}`);
    this.type = type;
    this.field = field;
    this.reason = reason;
  }
}

/**
 * @param {string} a
 * @param {string} b
 */
export function compareText(a, b) {
  return compareBytes(utf8(a), utf8(b));
}

/** @param {Iterable<string>} names */
export function uniqueInByteOrder(names) {
  return [...new Set(names)].sort(compareText);
}

// JSON equality by JCS; an absent value equals only an absent value.
/**
 * @param {Json | undefined} a
 * @param {Json | undefined} b
 */
export function sameJson(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return jcs(a) === jcs(b);
}

// An entity's declaration (§3.1): the registry type and scope its records live in, its decoder, and
// the protocols it takes. `checks` makes it Writable, `heldRemoval` Removable, `orderField` Ordered,
// `savesGuarded` Draftable and `timestampField` Timestamped.
/** @template E */
export class EntityType {
  /**
   * @param {{ type: string, scope: string, decode: (f: Fields) => E, checks?: import('./validation.js').Check<E>[],
   *   heldRemoval?: boolean, orderField?: string, savesGuarded?: boolean, timestampField?: string }} declaration
   */
  constructor({ type, scope, decode, checks, heldRemoval, orderField, savesGuarded, timestampField }) {
    precondition(savesGuarded === undefined || checks !== undefined, `${type}: a Draftable entity is Writable`);
    precondition(timestampField === undefined || savesGuarded !== undefined, `${type}: a Timestamped entity is Draftable`);
    this.type = type;
    this.scope = scope;
    this.decode = decode;
    this.checks = checks ?? null;
    this.heldRemoval = heldRemoval ?? null;
    this.orderField = orderField ?? null;
    this.savesGuarded = savesGuarded ?? null;
    this.timestampField = timestampField ?? null;
    Object.freeze(this);
  }

  get isWritable() {
    return this.checks !== null;
  }

  get isRemovable() {
    return this.heldRemoval !== null;
  }

  get isOrdered() {
    return this.orderField !== null;
  }

  get isDraftable() {
    return this.savesGuarded !== null;
  }

  get isTimestamped() {
    return this.timestampField !== null;
  }

  // The entity rebuilt from its own fields (§3.4 step 7); a failure is the declaration's fault.
  /**
   * @param {Id<E>} id
   * @param {Record<string, Json>} fields
   */
  decoding(id, fields) {
    try {
      return this.decode(Fields.values(this.type, id.record, fields));
    } catch (error) {
      if (error instanceof DecodeError) throw new Fault(`${this.type} does not decode its own fields: ${error.message}`);
      throw error;
    }
  }
}

/** @template E */
export class Id {
  /**
   * @param {RecordID} record
   * @param {EntityType<E>} entity
   */
  constructor(record, entity) {
    precondition(typeof record === 'string' || Array.isArray(record), `${entity.type}: an id is a string or a tuple`);
    this.record = record;
    this.entity = entity;
    Object.freeze(this);
  }

  /**
   * @template E
   * @param {LocalDay} day
   * @param {EntityType<E>} entity
   */
  static ofDay(day, entity) {
    return new Id(day.text, entity);
  }

  get day() {
    return typeof this.record === 'string' ? LocalDay.parse(this.record) : null;
  }

  /** @returns {RecordRef} */
  get ref() {
    return Object.freeze({ t: this.entity.type, id: this.record });
  }

  /** @returns {Json} */
  get json() {
    return this.record;
  }

  /** @param {Id<any>} other */
  equals(other) {
    return this.entity.type === other.entity.type && jcs(this.record) === jcs(other.record);
  }

  /**
   * @param {Id<any>} a
   * @param {Id<any>} b
   */
  static compare(a, b) {
    return compareJcs(a.record, b.record);
  }
}

// §3.3: a lenient reader of one record, or of one JSON object inside a record. A getter throws
// DecodeError for a field that is absent without a default, or holds another JSON kind; null is absent.
export class Fields {
  /**
   * @param {{ type: string, path: string, id: RecordID | null, values: Record<string, Json>, serials: Record<string, number> }} parts
   */
  constructor({ type, path, id, values, serials }) {
    this.type = type;
    this.path = path;
    this.recordId = id;
    this.values = values;
    this.serials = serials;
    Object.freeze(this);
  }

  /** @param {ViewRecord} record */
  static record(record) {
    /** @type {Record<string, Json>} */
    const values = {};
    for (const [name, register] of Object.entries(record.f ?? {})) values[name] = register[0];
    for (const [name, text] of Object.entries(record.x ?? {})) values[name] = text;
    return new Fields({ type: record.t, path: '', id: record.id, values, serials: { ...(record.v ?? {}) } });
  }

  /**
   * @param {Json} object
   * @param {string} type
   * @param {string} path
   */
  static object(object, type = '', path = '') {
    if (object === null || typeof object !== 'object' || Array.isArray(object)) throw new DecodeError(type, path, 'not an object');
    return new Fields({ type, path, id: null, values: object, serials: {} });
  }

  /**
   * @param {string} type
   * @param {RecordID} id
   * @param {Record<string, Json>} values
   */
  static values(type, id, values) {
    return new Fields({ type, path: '', id, values, serials: {} });
  }

  get id() {
    precondition(this.recordId !== null, 'the fields of a value object have no record id');
    return this.recordId;
  }

  /** @param {string} name */
  isAbsent(name) {
    const value = this.values[name];
    return value === undefined || value === null;
  }

  /** @param {string} name */
  present(name) {
    const value = this.values[name];
    if (value === undefined || value === null) throw this.failure(name, 'absent');
    return value;
  }

  /**
   * @param {string} name
   * @param {string} [fallback]
   */
  string(name, fallback) {
    if (fallback !== undefined && this.isAbsent(name)) return fallback;
    const value = this.present(name);
    if (typeof value !== 'string') throw this.failure(name, 'not a string');
    return value;
  }

  /** @param {string} name */
  optionalString(name) {
    return this.isAbsent(name) ? null : this.string(name);
  }

  /** @param {string} name */
  int(name) {
    const value = this.present(name);
    if (!Number.isSafeInteger(value)) throw this.failure(name, 'not an integer');
    return /** @type {number} */ (value);
  }

  /** @param {string} name */
  optionalInt(name) {
    return this.isAbsent(name) ? null : this.int(name);
  }

  /** @param {string} name */
  double(name) {
    const value = this.present(name);
    if (typeof value !== 'number') throw this.failure(name, 'not a number');
    return value;
  }

  /** @param {string} name */
  optionalDouble(name) {
    return this.isAbsent(name) ? null : this.double(name);
  }

  /**
   * @param {string} name
   * @param {boolean} [fallback]
   */
  bool(name, fallback) {
    if (fallback !== undefined && this.isAbsent(name)) return fallback;
    const value = this.present(name);
    if (typeof value !== 'boolean') throw this.failure(name, 'not a boolean');
    return value;
  }

  /** @param {string} name */
  instant(name) {
    const value = this.present(name);
    if (!Number.isSafeInteger(value)) throw this.failure(name, 'not an integer of milliseconds');
    return new Instant(/** @type {number} */ (value));
  }

  /** @param {string} name */
  optionalInstant(name) {
    return this.isAbsent(name) ? null : this.instant(name);
  }

  /**
   * @template E
   * @param {string} name
   * @param {EntityType<E>} entity
   */
  ref(name, entity) {
    const value = this.present(name);
    if (typeof value !== 'string' && !Array.isArray(value)) throw this.failure(name, 'not an id');
    return new Id(value, entity);
  }

  /**
   * @template E
   * @param {string} name
   * @param {EntityType<E>} entity
   */
  optionalRef(name, entity) {
    return this.isAbsent(name) ? null : this.ref(name, entity);
  }

  /**
   * @template V
   * @param {string} name
   * @param {(f: Fields) => V} decode
   */
  value(name, decode) {
    return decode(Fields.object(this.present(name), this.type, this.named(name)));
  }

  /**
   * @template V
   * @param {string} name
   * @param {(f: Fields) => V} decode
   */
  optionalValue(name, decode) {
    return this.isAbsent(name) ? null : this.value(name, decode);
  }

  /**
   * @template V
   * @param {string} name
   * @param {(f: Fields) => V} decode
   */
  list(name, decode) {
    const items = this.present(name);
    if (!Array.isArray(items)) throw this.failure(name, 'not an array');
    return items.map((item, index) => decode(Fields.object(item, this.type, `${this.named(name)}.${index}`)));
  }

  /**
   * @template V
   * @param {string} name
   * @param {(f: Fields) => V} decode
   */
  optionalList(name, decode) {
    return this.isAbsent(name) ? null : this.list(name, decode);
  }

  // A text field's text, "" when unset.
  /** @param {string} name */
  text(name) {
    const value = this.values[name];
    return typeof value === 'string' ? value : '';
  }

  // A view's serial, including a command prediction (engine §7.6).
  /** @param {string} name */
  serial(name) {
    const value = this.serials[name];
    return Number.isSafeInteger(value) ? /** @type {number} */ (value) : null;
  }

  // The raw value: undefined when the record has no such field, null when the field is null.
  /** @param {string} name */
  json(name) {
    const value = this.values[name];
    if (value !== undefined) return value;
    const serial = this.serials[name];
    return serial === undefined ? undefined : serial;
  }

  /** @param {string} name */
  named(name) {
    return this.path === '' ? name : `${this.path}.${name}`;
  }

  /**
   * @param {string} name
   * @param {string} reason
   */
  failure(name, reason) {
    return new DecodeError(this.type, this.named(name), reason);
  }
}
