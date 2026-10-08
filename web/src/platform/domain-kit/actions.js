// @ts-check
// §9.1 deciders and actions: a scope, a load over a Reader, a pure decide returning a decision; the
// outcome a run answers; and the two pure steps of the pipeline the runner applies to every plan: the
// gone check (§9.2 step 5) and the subject of an engine refusal (§12.1 rule 2).

import { isVisible } from '../../../../packages/api-contract/sync/reference/core/rows.js';
import { Id } from './entities.js';
import { Refused } from './refusals.js';
import { recordIdOf } from './translation.js';
import { Violation } from './values.js';

/** @typedef {import('./values.js').Json} Json */
/** @typedef {import('./entities.js').RecordRef} RecordRef */
/** @typedef {import('./plans.js').Plan} Plan */
/** @typedef {import('./reading.js').Reader} Reader */
/** @typedef {import('./reading.js').Views} Views */
/** @typedef {{ gestureId: string, localIds: string[], retired: string[], superseded?: string[], releaseAt: number | null }} CommitReceipt */
/**
 * @template T, R
 * @typedef {{ kind: 'write', plan: Plan, result: T } | { kind: 'unchanged', result: T } | { kind: 'refuse', refusal: R }} Decision
 */
/**
 * @template T, R
 * @typedef {{ kind: 'committed', result: T, receipt: CommitReceipt } | { kind: 'unchanged', result: T } | { kind: 'refused', refusal: R }} Outcome
 */
/**
 * A decider: its stored properties are its input; `load` reads through the reader only; `decide` is pure.
 * An action is a decider the runner runs.
 * @template L, T, R
 * @typedef {{ scope: string, refusals: import('./refusals.js').Refusals<R>, load(read: Reader): L, decide(loaded: L, ids: IDSource): Decision<T, R> }} Decider
 */

export const Decision = Object.freeze({
  /**
   * @template T
   * @param {Plan} plan
   * @param {T} result
   * @returns {Decision<T, never>}
   */
  write: (plan, result) => Object.freeze({ kind: 'write', plan, result }),
  /**
   * @template T
   * @param {T} result
   * @returns {Decision<T, never>}
   */
  unchanged: (result) => Object.freeze({ kind: 'unchanged', result }),
  /**
   * @template R
   * @param {R} refusal
   * @returns {Decision<never, R>}
   */
  refuse: (refusal) => Object.freeze({ kind: 'refuse', refusal }),
});

export const Outcome = Object.freeze({
  /**
   * @template T
   * @param {T} result
   * @param {CommitReceipt} receipt
   * @returns {Outcome<T, never>}
   */
  committed: (result, receipt) => Object.freeze({ kind: 'committed', result, receipt }),
  /**
   * @template T
   * @param {T} result
   * @returns {Outcome<T, never>}
   */
  unchanged: (result) => Object.freeze({ kind: 'unchanged', result }),
  /**
   * @template R
   * @param {R} refusal
   * @returns {Outcome<never, R>}
   */
  refused: (refusal) => Object.freeze({ kind: 'refused', refusal }),
});

// Valid only inside one run: ids minted in decide, so every plan names resolved ids (INV-10).
export class IDSource {
  /** @param {Views} views */
  constructor(views) {
    this.views = views;
    Object.freeze(this);
  }

  /**
   * @template E
   * @param {import('./entities.js').EntityType<E>} type
   */
  mint(type) {
    return new Id(this.views.mint(type.type), type);
  }

  opaqueID() {
    return this.views.opaqueID();
  }
}

// Decide with one refusal channel: a Violation decide throws becomes `refuse`.
/**
 * @template L, T, R
 * @param {Decider<L, T, R>} decider
 * @param {L} loaded
 * @param {IDSource} ids
 * @returns {Decision<T, R>}
 */
export function decision(decider, loaded, ids) {
  try {
    return decider.decide(loaded, ids);
  } catch (error) {
    if (error instanceof Violation) return Decision.refuse(decider.refusals.ofViolation(error));
    throw error;
  }
}

// §9.2 step 5: every update, remove or move of a type with life needs its record alive in `drawn`, and
// every anchor needs a visible member with an order key in `drawn` or in `stored`.
/**
 * @param {Plan} plan
 * @param {Views} views
 * @param {string} scope
 * @param {import('../../../../packages/api-contract/sync/reference/core/registry.js').Registry} registry
 * @returns {Refused | null}
 */
export function firstGone(plan, views, scope, registry) {
  for (const operation of plan.operations) {
    const type = operation.entity.type;
    const definition = registry.type(type);
    if (!definition || definition.scope !== registry.scopeKindOf(scope)) continue;
    const needsLife = operation.kind.op === 'update' || operation.kind.op === 'remove' || operation.kind.op === 'move';
    if (needsLife && definition.life && views.record('drawn', type, operation.id)?.life?.[0] !== 'alive') {
      return new Refused('unknown-record', operation.ref, null, 'predicted');
    }
    const anchor = operation.anchor;
    const order = operation.entity.orderField;
    if (anchor === null || order === null) continue;
    const listed = (/** @type {import('./entities.js').ViewRecord | undefined} */ record) =>
      record !== undefined && isVisible(definition, record) && typeof record.f?.[order]?.[0] === 'string';
    if (!listed(views.record('drawn', type, anchor)) && !listed(views.record('stored', type, anchor))) {
      return new Refused('unknown-record', { t: type, id: anchor }, null, 'predicted');
    }
  }
  return null;
}

// §12.1 rule 2: for `cap`, the first record the plan creates of the capped type; otherwise the first
// record the plan writes.
/**
 * @param {Plan} plan
 * @param {string} code
 * @param {Json | null} detail
 * @param {import('../../../../packages/api-contract/sync/reference/core/registry.js').Registry} registry
 * @returns {RecordRef | null}
 */
export function refusalSubject(plan, code, detail, registry) {
  const writing = plan.operations.filter((operation) => operation.writes);
  const refOf = (/** @type {import('./plans.js').Operation} */ operation) => ({ t: operation.entity.type, id: recordIdOf(operation, registry) });
  if (code === 'cap' && detail !== null && typeof detail === 'object' && !Array.isArray(detail)) {
    const created = writing.find((operation) => operation.creates && operation.entity.type === detail.type);
    if (created) return refOf(created);
  }
  const first = writing[0];
  return first ? refOf(first) : null;
}
