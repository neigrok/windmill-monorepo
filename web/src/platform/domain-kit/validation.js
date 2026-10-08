// @ts-check
// §4.5 checks and `Valid`: the only constructor of a validated entity. A plan accepts a Valid alone,
// recognised by the brand this module holds, so no field reaches the engine without its checks.

import { jcs } from '../../../../packages/api-contract/sync/reference/core/jcs.js';
import { uniqueInByteOrder } from './entities.js';
import { Fault, Path, Violation, firstNul, precondition } from './values.js';

/** @typedef {import('./values.js').Json} Json */
/** @typedef {import('./time.js').Moment} Moment */

// One field's LOCAL rules as a function of the entity and the moment, returning the entity with that
// field normalised; or a key check, which reads the id and the moment and returns nothing.
/** @template E */
export class Check {
  /**
   * @param {string | null} field
   * @param {(value: E, moment: Moment) => E} apply
   */
  constructor(field, apply) {
    this.field = field;
    this.apply = apply;
    Object.freeze(this);
  }

  /**
   * @template E
   * @param {(value: E, moment: Moment) => void} apply
   */
  static key(apply) {
    return new Check(null, (/** @type {E} */ value, /** @type {Moment} */ moment) => {
      apply(value, moment);
      return value;
    });
  }
}

const VALIDS = new WeakSet();

/** @param {unknown} candidate */
export function isValid(candidate) {
  return typeof candidate === 'object' && candidate !== null && VALIDS.has(candidate);
}

/**
 * @template {import('./entities.js').Writable<any>} E
 */
export class Valid {
  /**
   * @param {E} value
   * @param {Moment} at
   * @param {string[]} [fields] the fields to check; every field by default
   */
  constructor(value, at, fields) {
    const type = /** @type {import('./entities.js').EntityType<E>} */ (value.id.entity);
    precondition(type.checks !== null, `${type.type} is not Writable`);
    const checked = uniqueInByteOrder(fields ?? Object.keys(value.fields()));
    let checking = value;
    for (const check of type.checks) {
      if (check.field !== null && !checked.includes(check.field)) continue;
      const before = checking.fields();
      try {
        checking = check.apply(checking, at);
      } catch (error) {
        if (error instanceof Violation) throw error;
        throw new Fault(`a check of ${type.type} threw another error: ${error instanceof Error ? error.message : String(error)}`);
      }
      precondition(checking.id.equals(value.id), `a check of ${type.type} changed the record id`);
      if (check.field !== null) {
        const after = checking.fields();
        const others = new Set([...Object.keys(before), ...Object.keys(after)].filter((name) => name !== check.field));
        for (const name of others) precondition(jcs(before[name] ?? null) === jcs(after[name] ?? null), `the check of ${type.type}.${check.field} changed another field`);
      }
    }
    if (type.timestampField !== null && checked.includes(type.timestampField)) {
      checking = type.decoding(checking.id, { ...checking.fields(), [type.timestampField]: at.now.ms });
    }
    const written = checking.fields();
    for (const field of checked) {
      const nul = firstNul(written[field], new Path(field));
      if (nul) throw new Violation(`${type.type}.${field}`, nul, { kind: 'nul' });
    }
    this.value = checking;
    this.type = type;
    this.id = value.id;
    this.checked = Object.freeze(checked);
    this.written = Object.freeze(written);
    VALIDS.add(this);
    Object.freeze(this);
  }
}
