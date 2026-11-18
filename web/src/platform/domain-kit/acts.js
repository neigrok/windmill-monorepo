// @ts-check
import { Id } from './entities.js';
import { Reader, Views } from './reading.js';
import { precondition } from './values.js';

/** @typedef {{ scope: string, stamp: string | null, localIds: string[], ids: (import('./entities.js').RecordID | null)[] }} ActSegmentReceipt */
/** @typedef {{ gestureId: string, segments: ActSegmentReceipt[], retired: string[], superseded: string[], releaseAt: number | null }} ActReceipt */
/** @typedef {{ scopes: string[], hold: boolean, gestureId?: string, undo?: { version: 1, segments: { index: number, recipes: import('./values.js').Json[] }[] } }} ActRequest */
/** @typedef {{ now: number, finishLoad(): void, inScope<T>(scope: string, body: (views: import('./runner.js').CommitViews) => T): T, mintID(type: string, scope: string): import('./entities.js').RecordID, opaqueID(): string }} ActContext */
/**
 * @template L, T, R
 * @typedef {{ refusals: import('./refusals.js').Refusals<R>, load(read: ActReader): L, decide(loaded: L, ids: ActIDSource): ActDecision<T, R> }} ActAction
 */
/**
 * @template T, R
 * @typedef {{ kind: 'write', plan: ActPlan, result: T } | { kind: 'unchanged', result: T } | { kind: 'refuse', refusal: R }} ActDecision
 */
/**
 * @template T, R
 * @typedef {{ kind: 'committed', result: T, receipt: ActReceipt } | { kind: 'unchanged', result: T } | { kind: 'refused', refusal: R }} ActOutcome
 */
export class ScopedPlan {
  /** @param {string} scope @param {import('./plans.js').Plan} plan */
  constructor(scope, plan) { this.scope = scope; this.plan = plan; Object.freeze(this); }
}
export class ActPlan {
  /** @param {ScopedPlan[]} segments */
  constructor(segments) { this.segments = Object.freeze([...segments]); Object.freeze(this); }
}
export const ActDecision = Object.freeze({
  /** @template T @param {ActPlan} plan @param {T} result @returns {ActDecision<T, never>} */
  write: (plan, result) => Object.freeze({ kind: 'write', plan, result }),
  /** @template T @param {T} result @returns {ActDecision<T, never>} */
  unchanged: (result) => Object.freeze({ kind: 'unchanged', result }),
  /** @template R @param {R} refusal @returns {ActDecision<never, R>} */
  refuse: (refusal) => Object.freeze({ kind: 'refuse', refusal }),
});
export class ActReader {
  #open = true;
  /** @type {ActContext} */
  #context;
  /** @param {ActContext} context @param {import('./reading.js').Registry} registry @param {import('./time.js').Moment} moment */
  constructor(context, registry, moment) { this.#context = context; this.registry = registry; this.moment = moment; }
  /** @template T @param {string} scope @param {(reader: Reader) => T} body */
  inScope(scope, body) {
    precondition(this.#open, 'an act reader serves only load');
    return this.#context.inScope(scope, (input) => body(new Reader(new Views(this.registry, input), scope, this.moment)));
  }
  end() { this.#open = false; this.#context.finishLoad(); }
}
export class ActIDSource {
  /** @type {ActContext} */
  #context;
  /** @param {ActContext} context */
  constructor(context) { this.#context = context; Object.freeze(this); }
  /** @template E @param {import('./entities.js').EntityType<E>} type @param {string | null} [scope] */
  mint(type, scope = type.scope) { return new Id(this.#context.mintID(type.type, type.boundScope(scope)), type); }
  opaqueID() { return this.#context.opaqueID(); }
}
export class ActPrediction extends Error {
  /** @param {import('./refusals.js').Refused} refusal */
  constructor(refusal) { super('an act segment was refused'); this.refusal = refusal; }
}
