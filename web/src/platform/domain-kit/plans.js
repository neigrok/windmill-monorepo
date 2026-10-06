// @ts-check
// §8.1 plans: the vocabulary a decision writes with. Every writing operation takes a Valid, a plan
// runs at most one command, and a plan is held iff it removes a type whose removal is held.

import { uniqueInByteOrder } from './entities.js';
import { isValid } from './validation.js';
import { ChoiceSpec, Path, TextSpec, Violation, firstNul, precondition } from './values.js';

/** @typedef {import('./values.js').Json} Json */
/** @typedef {import('./values.js').ValueSpec} ValueSpec */
/** @typedef {import('./entities.js').RecordID} RecordID */
/** @typedef {import('./entities.js').RecordRef} RecordRef */
/** @typedef {import('./entities.js').EntityType<any>} AnyEntityType */
/** @typedef {import('./entities.js').Id<any>} AnyId */
/** @typedef {import('./validation.js').Valid<any>} AnyValid */
/**
 * A registry command: its name, the specs of its string arguments at `<name>.<argument>`, and its
 * arguments (`ref<t>` as an id, `time` and `instant` as epoch ms).
 * @typedef {{ name: string, specs: ValueSpec[], args: Record<string, Json> }} ServerCommand
 */
/** @typedef {{ name: string, args: Record<string, Json> }} Command */
/** @typedef {{ key: string, value: Json | null }} DeviceWrite */
/**
 * @typedef {{ op: 'create', named: readonly string[] | null, base: Record<string, Json> | null }
 *   | { op: 'insert', below: RecordID | null }
 *   | { op: 'update', named: readonly string[], base: Record<string, Json> | null, guarded: boolean }
 *   | { op: 'remove' } | { op: 'move', below: RecordID | null } | { op: 'guardRead', fields: readonly string[] }} OperationKind
 */

// A programming fault in a plan (§8.3): it fails the run and any test reaching it.
export class PlanError extends Error {
  /**
   * @param {number} rule
   * @param {string} reason
   */
  constructor(rule, reason) {
    super(`plan rule ${rule}: ${reason}`);
    this.rule = rule;
  }
}

// §8.4: the values a product expects a command to write, server-written fields included, unvalidated.
export class Prediction {
  /**
   * @param {'create' | 'update' | 'write' | 'remove'} kind
   * @param {string} type
   * @param {RecordID} id
   * @param {Record<string, Json>} values
   * @param {Record<string, string>} texts
   */
  constructor(kind, type, id, values, texts) {
    this.kind = kind;
    this.type = type;
    this.id = id;
    this.values = values;
    this.texts = texts;
    Object.freeze(this);
  }

  /**
   * @param {AnyId} id
   * @param {Record<string, Json>} values
   */
  static create(id, values) {
    return new Prediction('create', id.entity.type, id.record, values, {});
  }

  /**
   * @param {AnyId} id
   * @param {Record<string, Json>} values
   */
  static update(id, values) {
    return new Prediction('update', id.entity.type, id.record, values, {});
  }

  /**
   * @param {AnyId} id
   * @param {Record<string, Json>} values
   * @param {Record<string, string>} texts
   */
  static write(id, values, texts = {}) {
    return new Prediction('write', id.entity.type, id.record, values, texts);
  }

  /** @param {AnyId} id */
  static remove(id) {
    return new Prediction('remove', id.entity.type, id.record, {}, {});
  }
}

export class Operation {
  /**
   * @param {OperationKind} kind
   * @param {AnyEntityType} entity
   * @param {RecordID} id
   * @param {Record<string, Json>} values
   * @param {readonly string[]} checked
   */
  constructor(kind, entity, id, values = {}, checked = []) {
    this.kind = kind;
    this.entity = entity;
    this.id = id;
    this.values = values;
    this.checked = checked;
    Object.freeze(this);
  }

  /** @returns {RecordRef} */
  get ref() {
    return { t: this.entity.type, id: this.id };
  }

  get writes() {
    return this.kind.op !== 'guardRead';
  }

  get creates() {
    return this.kind.op === 'create' || this.kind.op === 'insert';
  }

  // The member an insert or a move lands below; null at the top or for any other operation.
  get anchor() {
    return this.kind.op === 'insert' || this.kind.op === 'move' ? this.kind.below : null;
  }
}

// A command's string arguments at a spec's path, nested ones included, normalised by the spec.
/**
 * @param {ValueSpec} spec
 * @param {Json} json
 * @param {string[]} keys
 * @param {Path} path
 * @returns {Json}
 */
function applying(spec, json, keys, path) {
  if (Array.isArray(json)) return json.map((item, index) => applying(spec, item, keys, path.plus(index)));
  if (json !== null && typeof json === 'object') {
    const [key, ...rest] = keys;
    if (key === undefined || !Object.hasOwn(json, key)) return json;
    return { ...json, [key]: applying(spec, /** @type {Json} */ (json[key]), rest, path.plus(key)) };
  }
  if (typeof json !== 'string' || keys.length) return json;
  if (spec instanceof TextSpec || spec instanceof ChoiceSpec) return spec.apply(json, path);
  return json;
}

export class Plan {
  constructor() {
    /** @type {Operation[]} */
    this.writing = [];
    /** @type {Command | null} */
    this.command = null;
    /** @type {Prediction[]} */
    this.predictions = [];
    /** @type {DeviceWrite[]} */
    this.deviceWrites = [];
  }

  // §8.4: a plan running a command, its string arguments normalised by the command's specs; a
  // Violation ends the decision, which refuses.
  /**
   * @param {ServerCommand} command
   * @param {Prediction[]} predicting
   */
  static running(command, predicting = []) {
    const prefix = `${command.name}.`;
    /** @type {Json} */
    let args = { ...command.args };
    for (const spec of command.specs) {
      precondition(spec.path.startsWith(prefix), `the spec ${spec.path} is not at ${command.name}.<argument>`);
      args = applying(spec, args, spec.path.slice(prefix.length).split('.'), new Path(''));
    }
    const nul = firstNul(args, new Path(''));
    if (nul) throw new Violation(`${command.name}.${nul.text.split('.')[0]}`, nul, { kind: 'nul' });
    const plan = new Plan();
    plan.command = { name: command.name, args: /** @type {Record<string, Json>} */ (args) };
    plan.predictions = [...predicting];
    return plan;
  }

  get operations() {
    return Object.freeze([...this.writing]);
  }

  // Held iff it removes a type whose removal is held (§8.1).
  get isHeld() {
    return this.writing.some((operation) => operation.kind.op === 'remove' && operation.entity.heldRemoval === true);
  }

  /**
   * @param {AnyValid} valid
   * @param {{ fields?: string[], from?: import('./entities.js').Writable<any> }} [options]
   */
  create(valid, { fields, from } = {}) {
    this.append({ op: 'create', named: fields ? uniqueInByteOrder(fields) : null, base: from ? from.fields() : null }, valid);
  }

  /**
   * @param {AnyValid} valid
   * @param {RecordID | null} below
   */
  insert(valid, below) {
    this.append({ op: 'insert', below }, valid);
  }

  /**
   * @param {AnyValid} valid
   * @param {{ fields?: readonly string[], from?: import('./entities.js').Writable<any>, guarded?: boolean }} [options]
   */
  update(valid, { fields, from, guarded = false } = {}) {
    this.append({ op: 'update', named: uniqueInByteOrder(fields ?? valid.checked), base: from ? from.fields() : null, guarded }, valid);
  }

  /** @param {AnyId} id */
  remove(id) {
    precondition(id.entity.isRemovable, `${id.entity.type} is not Removable`);
    this.writing.push(new Operation({ op: 'remove' }, id.entity, id.record));
  }

  /**
   * @param {AnyId} id
   * @param {AnyId | null} below
   */
  move(id, below) {
    precondition(id.entity.isOrdered, `${id.entity.type} is not Ordered`);
    this.writing.push(new Operation({ op: 'move', below: below ? below.record : null }, id.entity, id.record));
  }

  /**
   * @param {AnyId} id
   * @param {string[]} fields
   */
  guardRead(id, fields) {
    this.writing.push(new Operation({ op: 'guardRead', fields: uniqueInByteOrder(fields) }, id.entity, id.record));
  }

  /**
   * @param {string} key
   * @param {Json | null} value
   */
  device(key, value) {
    this.deviceWrites.push({ key, value });
  }

  /**
   * @param {OperationKind} kind
   * @param {AnyValid} valid
   */
  append(kind, valid) {
    precondition(isValid(valid), 'a plan writes a Valid value only');
    this.writing.push(new Operation(kind, valid.type, valid.id.record, valid.written, valid.checked));
  }
}
