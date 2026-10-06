// @ts-check
// Shared-vector support (§15): the contract directory, a vector's records as the engine's view records,
// the commit double every write vector runs over, and the JSON forms of the kit's values.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry } from '../../../src/platform/sync/core/registry.js';
import { viewRecord } from '../../../src/platform/sync/client/views.js';
import { Views } from '../../../src/platform/domain-kit/reading.js';
import { FixedZone, Instant, Moment } from '../../../src/platform/domain-kit/time.js';
import { translate } from '../../../src/platform/domain-kit/translation.js';
import { ChoiceSpec, CountSpec, Fault, NumberSpec, Path, TextSpec } from '../../../src/platform/domain-kit/values.js';

/** @typedef {import('../../../src/platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../src/platform/domain-kit/entities.js').RecordID} RecordID */
/** @typedef {import('../../../src/platform/domain-kit/entities.js').ViewRecord} ViewRecord */
/** @typedef {import('../../../src/platform/domain-kit/translation.js').Gesture} Gesture */
/** @typedef {import('../../../src/platform/domain-kit/runner.js').CommitOutcome} CommitOutcome */
/** @typedef {{ file: string, name: string, input: any, expect: Json }} Vector */

// A vector that cannot be read as the README states it.
export class ContractError extends Error {}

export const Contract = Object.freeze({
  root() {
    let directory = dirname(fileURLToPath(import.meta.url));
    while (true) {
      const candidate = join(directory, 'packages', 'api-contract');
      if (statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) return candidate;
      const parent = dirname(directory);
      if (parent === directory) throw new ContractError(`no packages/api-contract above ${fileURLToPath(import.meta.url)}`);
      directory = parent;
    }
  },

  /** @param {string} path */
  json(path) {
    return /** @type {Json} */ (JSON.parse(readFileSync(join(Contract.root(), path), 'utf8')));
  },

  /**
   * @param {string} path
   * @returns {Vector[]}
   */
  vectors(path) {
    const document = Contract.json(path);
    if (!Array.isArray(document)) throw new ContractError(`${path} is not an array of vectors`);
    const names = new Set();
    return document.map((/** @type {any} */ entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new ContractError(`${path}: a vector is an object`);
      const keys = Object.keys(entry).sort();
      if (keys.join() !== 'expect,input,name' || typeof entry.name !== 'string') throw new ContractError(`${path}: a vector is {name, input, expect}`);
      if (names.has(entry.name)) throw new ContractError(`duplicate vector ${path} · ${entry.name}`);
      names.add(entry.name);
      return { file: path, name: entry.name, input: entry.input, expect: /** @type {Json} */ (entry.expect ?? null) };
    });
  },

  // Every `.json` under a contract directory, as `<directory>/<relative path>`, sorted.
  /** @param {string} directory */
  files(directory) {
    const base = join(Contract.root(), directory);
    /**
     * @param {string} relative
     * @returns {string[]}
     */
    const walk = (relative) => readdirSync(join(base, relative), { withFileTypes: true }).flatMap((entry) => {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith('.json') ? [`${directory}/${path}`] : [];
    });
    return walk('').sort();
  },
});

export const probeRegistry = new Registry(Contract.json('sync/probe.registry.json'));

// The README's defaults: 2027-01-15T08:00:00Z in UTC unless a vector gives `now` and `offsetSeconds`.
export const DEFAULT_NOW = 1_800_000_000_000;

/** @param {any} input */
export function momentOf(input) {
  return new Moment(new Instant(input.now ?? DEFAULT_NOW), new FixedZone(input.offsetSeconds ?? 0));
}

/** @param {any[] | undefined} rows */
export function viewRecords(rows) {
  return (rows ?? []).map((row) => /** @type {ViewRecord} */ (viewRecord(row)));
}

// A vector's records as the kit's Views: rows become view records, ids are minted from the given list.
/**
 * @param {{ drawn?: any[], stored?: any[] }} records
 * @param {{ ids?: RecordID[], firstPullComplete?: boolean }} [options]
 */
export function vectorViews(records, { ids = [], firstPullComplete = true } = {}) {
  const left = [...ids];
  return Views.ofRecords(probeRegistry, {
    drawn: viewRecords(records.drawn),
    stored: viewRecords(records.stored ?? records.drawn),
    firstPullComplete,
    mintId: (type) => {
      const id = left.shift();
      if (id === undefined) throw new Fault(`the vector lists no id left to mint a ${type}`);
      return id;
    },
  });
}

// The commit double (D-18's port) every run and script vector runs over: it answers the receipt the
// vector gives, or `g<k>` for its k-th committed gesture, and never changes its records by itself.
export class VectorReplica {
  /**
   * @param {{ drawn?: any[], stored?: any[] }} records
   * @param {number} now
   * @param {CommitOutcome | null} answer
   */
  constructor(records, now, answer = null) {
    this.records = records;
    this.now = now;
    this.answer = answer;
    /** @type {Gesture[]} */
    this.gestures = [];
    this.failNext = false;
  }

  /** @param {string} scope */
  read(scope) {
    const views = vectorViews(this.records);
    return { drawn: views.drawn, stored: views.stored, devices: {}, firstPullComplete: true };
  }

  /**
   * @template T
   * @param {string} scope
   * @param {(views: import('../../../src/platform/domain-kit/runner.js').CommitViews) => { gesture: Gesture | null, value: T }} body
   */
  commit(scope, body) {
    const { gesture, value } = body({ ...this.read(scope), now: this.now });
    if (this.failNext) {
      this.failNext = false;
      throw new Error('the disk is full');
    }
    if (gesture === null) return { outcome: null, value };
    this.gestures.push(gesture);
    const id = `g${this.gestures.length}`;
    return { outcome: this.answer ?? { receipt: { gestureId: id, localIds: [`${id}/0`], retired: [], releaseAt: null } }, value };
  }

  /** @param {string} gestureId */
  undo(gestureId) {
    return false;
  }

  /**
   * @param {string} type
   * @returns {never}
   */
  mintId(type) {
    throw new Fault(`a vector mints no ${type} outside its id list`);
  }

  physNow() {
    return this.now;
  }

  /** @param {string} id */
  dismissNotice(id) {
    throw new ContractError(`a vector's commit writes no notice, and ${id} was dismissed`);
  }
}

// A spec from its JSON form; a number spec that is both integer and quantised traps here, as the kit does.
/** @param {any} json */
export function specOf(json) {
  switch (json.kind) {
    case 'text':
      return new TextSpec(json.path, { unit: json.unit, min: json.min, max: json.max, trim: json.trim, nfc: json.nfc });
    case 'number':
      return new NumberSpec(json.path, { min: json.min, max: json.max, integer: json.integer ?? false, quantum: json.quantum ?? null });
    case 'choice':
      return new ChoiceSpec(json.path, json.values);
    case 'count':
      return new CountSpec(json.path, { min: json.min, max: json.max });
    default:
      throw new ContractError(`unknown spec kind ${json.kind}`);
  }
}

// A spec applied to one raw value: null passes the optional overload, and a non-finite number is
// written as its name.
/**
 * @param {import('../../../src/platform/domain-kit/values.js').ValueSpec} spec
 * @param {Json} value
 * @param {Path} at
 * @param {boolean} asInt
 * @returns {Json}
 */
export function applySpec(spec, value, at, asInt = false) {
  if (value === null) return null;
  if (spec instanceof TextSpec || spec instanceof ChoiceSpec) {
    if (typeof value !== 'string') throw new ContractError(`${spec.path} applies to a string`);
    return spec.apply(value, at);
  }
  if (spec instanceof NumberSpec) {
    const named = { NaN: Number.NaN, Infinity: Number.POSITIVE_INFINITY, '-Infinity': Number.NEGATIVE_INFINITY };
    const number = typeof value === 'number' ? value : named[/** @type {keyof typeof named} */ (String(value))];
    if (number === undefined) throw new ContractError(`${spec.path} applies to a number`);
    if (asInt && !Number.isSafeInteger(number)) throw new ContractError(`${spec.path} applies to an int`);
    return spec.apply(number, at);
  }
  throw new ContractError(`${spec.path} is no value spec`);
}

/** @param {any} json */
export function placementOf(json) {
  if (json === undefined || json === null) return null;
  if (json === 'top') return /** @type {import('../../../src/platform/domain-kit/reading.js').Placement} */ ({ kind: 'top' });
  if (json === 'bottom') return /** @type {import('../../../src/platform/domain-kit/reading.js').Placement} */ ({ kind: 'bottom' });
  return /** @type {import('../../../src/platform/domain-kit/reading.js').Placement} */ ({ kind: 'below', id: json.below });
}

/**
 * @param {import('../../../src/platform/domain-kit/reading.js').Placement | null} placement
 * @returns {Json}
 */
export function placementForm(placement) {
  if (placement === null) return null;
  if (placement.kind === 'below') return { below: placement.id };
  return placement.kind;
}

/**
 * @param {import('../../../src/platform/domain-kit/actions.js').CommitReceipt} receipt
 * @returns {Json}
 */
export function receiptForm(receipt) {
  return { gestureId: receipt.gestureId, localIds: receipt.localIds, retired: receipt.retired, releaseAt: receipt.releaseAt };
}

/**
 * @param {import('../../../src/platform/domain-kit/drafts.js').Saved} saved
 * @returns {Json}
 */
export function savedForm(saved) {
  return { values: { ...saved.values }, exists: saved.exists };
}

/**
 * @param {import('../../../src/platform/domain-kit/drafts.js').Draft<any>} draft
 * @returns {Json}
 */
export function draftForm(draft) {
  return { id: draft.id.json, base: draft.base.fields(), current: draft.current.fields(), isNew: draft.isNew, placement: placementForm(draft.placement) };
}

/**
 * @template T, R
 * @param {import('../../../src/platform/domain-kit/actions.js').Decision<T, R>} decision
 * @param {string} scope
 * @param {(result: T) => Json} resultForm
 * @param {(refusal: R) => Json} refusalForm
 * @returns {Json}
 */
export function decisionForm(decision, scope, resultForm, refusalForm) {
  switch (decision.kind) {
    case 'write':
      return { write: { gesture: /** @type {Json} */ (/** @type {unknown} */ (translate(decision.plan, scope, probeRegistry))), result: resultForm(decision.result) } };
    case 'unchanged':
      return { unchanged: { result: resultForm(decision.result) } };
    default:
      return { refuse: refusalForm(decision.refusal) };
  }
}

/**
 * @template T, R
 * @param {import('../../../src/platform/domain-kit/actions.js').Outcome<T, R>} outcome
 * @param {(result: T) => Json} resultForm
 * @param {(refusal: R) => Json} refusalForm
 * @returns {Json}
 */
export function outcomeForm(outcome, resultForm, refusalForm) {
  switch (outcome.kind) {
    case 'committed':
      return { committed: { result: resultForm(outcome.result), receipt: receiptForm(outcome.receipt) } };
    case 'unchanged':
      return { unchanged: { result: resultForm(outcome.result) } };
    default:
      return { refused: refusalForm(outcome.refusal) };
  }
}

// The records of a vector in reverse, wherever it lists them: a view that depends on row order
// rather than id bytes fails the second run.
/**
 * @param {any} input
 * @returns {any}
 */
export function withRecordsReversed(input) {
  if (Array.isArray(input)) return input.map(withRecordsReversed);
  if (input === null || typeof input !== 'object') return input;
  return Object.fromEntries(Object.entries(input).map(([key, value]) =>
    [key, (key === 'drawn' || key === 'stored') && Array.isArray(value) ? [...value].reverse() : withRecordsReversed(value)]));
}

/**
 * @param {any} input
 * @returns {boolean}
 */
export function listsRecords(input) {
  if (Array.isArray(input)) return input.some(listsRecords);
  if (input === null || typeof input !== 'object') return false;
  return Object.entries(input).some(([key, value]) => ((key === 'drawn' || key === 'stored') && Array.isArray(value) && value.length > 1) || listsRecords(value));
}

