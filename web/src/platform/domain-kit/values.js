// @ts-check
// §4 values: specs declared as data, their fail-fast pipelines, the violation a value breaks a rule
// with, and the kit's two faults a product can reach from here.

import { lengthIn, roundToQuantum } from '../sync/core/values.js';

/** @typedef {null | boolean | number | string | Json[] | {[key: string]: Json}} Json */
/** @typedef {'chars' | 'bytes'} TextUnit */
/** @typedef {{ path: string, json: Json }} ValueSpec */
/**
 * @template V
 * @typedef {{ json: Json, validated(at: Path): V }} ValueObject
 */
/**
 * @typedef {{ kind: 'blank' } | { kind: 'nul' } | { kind: 'notANumber' } | { kind: 'notInteger' } | { kind: 'notOneOf' }
 *   | { kind: 'tooShort', min: number, unit: TextUnit } | { kind: 'tooLong', max: number, unit: TextUnit, measured: number }
 *   | { kind: 'below', min: number } | { kind: 'above', max: number } | { kind: 'tooFew', min: number } | { kind: 'tooMany', max: number }
 *   | { kind: 'custom', custom: string }} Reason
 */

// A kit precondition a product broke: a programming fault that fails the run, never an outcome.
export class Fault extends Error {}

/**
 * @param {boolean} condition
 * @param {string} message
 * @returns {asserts condition}
 */
export function precondition(condition, message) {
  if (!condition) throw new Fault(message);
}

export class Path {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
    Object.freeze(this);
  }

  /** @param {string | number} key */
  plus(key) {
    return new Path(this.text === '' ? String(key) : `${this.text}.${key}`);
  }
}

export class Violation extends Error {
  /**
   * @param {string} rule
   * @param {Path} path
   * @param {Reason} reason
   */
  constructor(rule, path, reason) {
    super(`${rule} at ${path.text}: ${reason.kind}`);
    this.rule = rule;
    this.path = path;
    this.reason = reason;
  }

  /** @returns {Json} */
  get json() {
    const { kind, ...members } = this.reason;
    return { rule: this.rule, path: this.path.text, reason: kind, ...members };
  }
}

// §4.3 text: NFC, then the one whitespace set (ECMAScript `\s`, which `trim` removes), then U+0000, then the measure.
export class TextSpec {
  /**
   * @param {string} path
   * @param {{ unit: TextUnit, min: number, max: number, trim: boolean, nfc: boolean }} rule
   */
  constructor(path, { unit, min, max, trim, nfc }) {
    this.path = path;
    this.unit = unit;
    this.min = min;
    this.max = max;
    this.trim = trim;
    this.nfc = nfc;
    Object.freeze(this);
  }

  /** @returns {Json} */
  get json() {
    return { path: this.path, kind: 'text', unit: this.unit, min: this.min, max: this.max, trim: this.trim, nfc: this.nfc };
  }

  /** @param {string} value */
  normalised(value) {
    const composed = this.nfc ? value.normalize('NFC') : value;
    return this.trim ? composed.trim() : composed;
  }

  /** @param {string} value */
  measure(value) {
    return lengthIn(this.unit, this.normalised(value));
  }

  /**
   * @param {string} value
   * @param {Path} at
   * @returns {string}
   */
  apply(value, at) {
    const text = this.normalised(value);
    if (text.includes('\u0000')) throw new Violation(this.path, at, { kind: 'nul' });
    const measured = lengthIn(this.unit, text);
    if (measured === 0 && this.min >= 1) throw new Violation(this.path, at, { kind: 'blank' });
    if (measured < this.min) throw new Violation(this.path, at, { kind: 'tooShort', min: this.min, unit: this.unit });
    if (measured > this.max) throw new Violation(this.path, at, { kind: 'tooLong', max: this.max, unit: this.unit, measured });
    return text;
  }

  /**
   * @param {string | null} value
   * @param {Path} at
   */
  applyOptional(value, at) {
    return value === null ? null : this.apply(value, at);
  }

  /** @param {string} value */
  static isBlank(value) {
    return /^\s*$/u.test(value);
  }
}

// §4.3 number: finite, integral when asked, rounded to the quantum, then the bounds on the rounded value.
export class NumberSpec {
  /**
   * @param {string} path
   * @param {{ min: number, max: number, integer?: boolean, quantum?: number | null }} rule
   */
  constructor(path, { min, max, integer = false, quantum = null }) {
    precondition(!(integer && quantum !== null), `${path}: a number spec is integer or has a quantum, not both`);
    precondition(quantum === null || Number.isInteger(quantum) || Number.isInteger(1 / quantum), `${path}: a quantum is an integer or 1/k`);
    this.path = path;
    this.min = min;
    this.max = max;
    this.integer = integer;
    this.quantum = quantum;
    Object.freeze(this);
  }

  /** @returns {Json} */
  get json() {
    const json = { path: this.path, kind: 'number', min: this.min, max: this.max, integer: this.integer };
    return this.quantum === null ? json : { ...json, quantum: this.quantum };
  }

  /**
   * @param {number} value
   * @param {Path} at
   * @returns {number}
   */
  apply(value, at) {
    if (!Number.isFinite(value)) throw new Violation(this.path, at, { kind: 'notANumber' });
    if (this.integer && !Number.isInteger(value)) throw new Violation(this.path, at, { kind: 'notInteger' });
    const rounded = this.quantum === null ? value : roundToQuantum(value, this.quantum);
    if (rounded < this.min) throw new Violation(this.path, at, { kind: 'below', min: this.min });
    if (rounded > this.max) throw new Violation(this.path, at, { kind: 'above', max: this.max });
    return rounded;
  }

  /**
   * @param {number | null} value
   * @param {Path} at
   */
  applyOptional(value, at) {
    return value === null ? null : this.apply(value, at);
  }
}

// §4.3 choice: one of the values, byte for byte.
export class ChoiceSpec {
  /**
   * @param {string} path
   * @param {string[]} values
   */
  constructor(path, values) {
    this.path = path;
    this.values = Object.freeze([...values]);
    Object.freeze(this);
  }

  /** @returns {Json} */
  get json() {
    return { path: this.path, kind: 'choice', values: [...this.values] };
  }

  /**
   * @param {string} value
   * @param {Path} at
   * @returns {string}
   */
  apply(value, at) {
    if (!this.values.includes(value)) throw new Violation(this.path, at, { kind: 'notOneOf' });
    return value;
  }

  /**
   * @param {string | null} value
   * @param {Path} at
   */
  applyOptional(value, at) {
    return value === null ? null : this.apply(value, at);
  }
}

// §4.3 count: the bounds before the items, then each item validated at its index.
export class CountSpec {
  /**
   * @param {string} path
   * @param {{ min: number, max: number }} rule
   */
  constructor(path, { min, max }) {
    this.path = path;
    this.min = min;
    this.max = max;
    Object.freeze(this);
  }

  /** @returns {Json} */
  get json() {
    return { path: this.path, kind: 'count', min: this.min, max: this.max };
  }

  /**
   * @template V
   * @param {V[]} items
   * @param {Path} at
   * @param {(item: V, at: Path) => V} validate
   * @returns {V[]}
   */
  apply(items, at, validate = (item, path) => /** @type {ValueObject<V>} */ (item).validated(path)) {
    if (items.length < this.min) throw new Violation(this.path, at, { kind: 'tooFew', min: this.min });
    if (items.length > this.max) throw new Violation(this.path, at, { kind: 'tooMany', max: this.max });
    return items.map((item, index) => validate(item, at.plus(index)));
  }

  /**
   * @template V
   * @param {V[] | null} items
   * @param {Path} at
   * @param {(item: V, at: Path) => V} [validate]
   */
  applyOptional(items, at, validate) {
    return items === null ? null : this.apply(items, at, validate);
  }
}

// The path of the first U+0000 in a JSON value, through objects by key and arrays by index, or null.
/**
 * @param {Json | undefined} value
 * @param {Path} at
 * @returns {Path | null}
 */
export function firstNul(value, at) {
  if (typeof value === 'string') return value.includes('\u0000') ? at : null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = firstNul(item, at.plus(index));
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const found = firstNul(value[key], at.plus(key));
      if (found) return found;
    }
  }
  return null;
}
