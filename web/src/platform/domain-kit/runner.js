// @ts-check
// §9.2 the runner: the one kit object that holds the replica port, and the kit's one impure file. It runs
// an action as one engine commit, opens and saves drafts, and binds the browser engine through
// `EngineReplica`. The commit body stays synchronous; only the transaction's completion is awaited.

import { mintId } from '../sync/core/derive.js';
import { recordKey } from '../sync/core/rows.js';
import { IDSource, Outcome, decision, firstGone, refusalSubject } from './actions.js';
import { Draft, SaveDraft, SaveResult } from './drafts.js';
import { DecodeError, Id } from './entities.js';
import { PlanError } from './plans.js';
import { Reader, Views } from './reading.js';
import { Refused } from './refusals.js';
import { Instant, Moment } from './time.js';
import { translate } from './translation.js';
import { Fault, precondition } from './values.js';

let insideRun = false;

/** @typedef {import('./values.js').Json} Json */
/** @typedef {import('./entities.js').RecordID} RecordID */
/** @typedef {import('./entities.js').ViewRecord} ViewRecord */
/** @typedef {import('./actions.js').CommitReceipt} CommitReceipt */
/** @typedef {import('./translation.js').Gesture} Gesture */
/**
 * What a replica hands a read or a commit body: the scope's views and reconciliation metadata,
 * all read from the same replica; a commit adds its `now`.
 * @typedef {{ drawn: Map<string, ViewRecord>, stored: Map<string, ViewRecord>, confirmed?: Map<string, ViewRecord> } & import('./reading.js').ViewMetadata} ReadViews
 * @typedef {ReadViews & { now: number }} CommitViews
 * @typedef {{ receipt: CommitReceipt } | { refused: { code: string, detail: Json | null, notice: string | null } }} CommitOutcome
 */
/**
 * The replica port (D-18, ER-2): `commit` runs its synchronous body in one local transaction and
 * answers after it; a body returning no gesture writes nothing. `EngineReplica` is the browser engine's.
 * @typedef {{
 *   commit<T>(scope: string, body: (views: CommitViews) => { gesture: Gesture | null, value: T }): Promise<{ outcome: CommitOutcome | null, value: T }> | { outcome: CommitOutcome | null, value: T },
 *   read(scope: string): ReadViews,
 *   undo(gestureId: string): Promise<boolean> | boolean,
 *   mintId(type: string, taken: Set<string>): RecordID,
 *   opaqueID?(): string,
 *   physNow(): number,
 *   dismissNotice(id: string): Promise<unknown> | unknown,
 * }} Replica
 */

/** @param {unknown} value */
function isThenable(value) {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

// The ids a type already holds in a view, so a mint never draws one of them.
/**
 * @param {Map<string, ViewRecord>} drawn
 * @param {string} type
 */
function takenIn(drawn, type) {
  return new Set([...drawn.values()].filter((record) => record.t === type && typeof record.id === 'string').map((record) => /** @type {string} */ (record.id)));
}

export class ActionRunner {
  /**
   * @param {Replica} replica
   * @param {import('../sync/core/registry.js').Registry} registry
   * @param {import('./time.js').Zone} zone
   */
  constructor(replica, registry, zone) {
    this.replica = replica;
    this.registry = registry;
    this.zone = zone;
  }

  /**
   * @template L, T, R
   * @param {import('./actions.js').Decider<L, T, R>} action
   * @returns {Promise<import('./actions.js').Outcome<T, R>>}
   */
  async run(action) {
    return this.perform(action);
  }

  // Steps 2–7 of §9.2: one commit whose body loads, decides, checks for gone records and translates.
  /**
   * @template L, T, R
   * @param {import('./actions.js').Decider<L, T, R>} decider
   * @returns {Promise<import('./actions.js').Outcome<T, R>>}
   */
  async perform(decider) {
    precondition(!insideRun, 'a run cannot enter inside a run');
    const scope = decider.scope;
    /** @typedef {{ done: import('./actions.js').Outcome<T, R> } | { writing: { plan: import('./plans.js').Plan, result: T } }} Step */
    /** @type {{ outcome: CommitOutcome | null, value: Step }} */
    let committed;
    try {
      committed = await this.replica.commit(scope, /** @returns {{ gesture: Gesture | null, value: Step }} */ (input) => {
        insideRun = true;
        try {
          const views = this.viewsOf(scope, input);
          const reader = new Reader(views, scope, new Moment(new Instant(input.now), this.zone));
          const loaded = decider.load(reader);
          precondition(!isThenable(loaded), 'a decider loads synchronously');
          const decided = decision(decider, loaded, new IDSource(views));
          precondition(!isThenable(decided), 'a decider decides synchronously');
          if (decided.kind === 'refuse') return { gesture: null, value: { done: Outcome.refused(decided.refusal) } };
          if (decided.kind === 'unchanged') return { gesture: null, value: { done: Outcome.unchanged(decided.result) } };
          const gone = firstGone(decided.plan, views, scope, this.registry);
          if (gone) return { gesture: null, value: { done: Outcome.refused(decider.refusals.ofRefused(gone)) } };
          return { gesture: translate(decided.plan, scope, this.registry), value: { writing: { plan: decided.plan, result: decided.result } } };
        } finally { insideRun = false; }
      });
    } catch (error) {
      if (error instanceof Error && 'kind' in error && error.kind === 'malformed') throw new Fault(`a malformed commit is a programming fault: ${error.message}`);
      throw error;
    }
    const { outcome, value } = committed;
    if ('done' in value) return value.done;
    const { plan, result } = value.writing;
    precondition(outcome !== null, 'the engine answered a gesture without an outcome');
    if ('refused' in outcome) {
      const { code, detail, notice } = outcome.refused;
      if (notice !== null) await this.replica.dismissNotice(notice);
      insideRun = true;
      try { return Outcome.refused(decider.refusals.ofRefused(new Refused(code, refusalSubject(plan, code, detail, this.registry), detail, 'predicted'))); }
      finally { insideRun = false; }
    }
    const { receipt } = outcome;
    const wroteNothing = receipt.localIds.length === 0 && receipt.retired.length === 0
      && (receipt.superseded?.length ?? 0) === 0 && plan.deviceWrites.length === 0;
    return wroteNothing ? Outcome.unchanged(result) : Outcome.committed(result, receipt);
  }

  /**
   * @param {string} scope
   * @param {ReadViews} input
   */
  viewsOf(scope, input) {
    const opaqueID = input.opaqueID ?? this.replica.opaqueID?.bind(this.replica);
    return new Views(this.registry, { ...input, ...(opaqueID ? { opaqueID } : {}),
      mintId: (type) => this.replica.mintId(type, takenIn(input.drawn, type)) });
  }

  // A derived read outside any commit, over the replica's current views.
  /**
   * @template T
   * @param {string} scope
   * @param {(read: Reader) => T} body
   */
  read(scope, body) {
    return body(new Reader(this.viewsOf(scope, this.replica.read(scope)), scope, this.moment()));
  }

  /** @param {string} gestureId */
  async undo(gestureId) {
    return this.replica.undo(gestureId);
  }

  /**
   * @template E
   * @param {import('./entities.js').EntityType<E>} type
   */
  mint(type) {
    return new Id(this.replica.mintId(type.type, takenIn(this.replica.read(type.scope).drawn, type.type)), type);
  }

  moment() {
    return new Moment(new Instant(this.replica.physNow()), this.zone);
  }

  // §10.1: the draft of a record the person sees, or null.
  /**
   * @template {import('./entities.js').Writable<any>} E
   * @param {import('./entities.js').EntityType<E>} type
   * @param {import('./entities.js').Id<E>} id
   */
  open(type, id) {
    const found = this.read(type.scope, (read) => read.repository(type).find(id, 'drawn'));
    return found === null ? null : Draft.opening(found);
  }

  // A keyed or singleton record's draft, or a new draft of its blank.
  /**
   * @template {import('./entities.js').Writable<any>} E
   * @param {import('./entities.js').EntityType<E>} type
   * @param {import('./entities.js').Id<E>} id
   * @param {E} blank
   */
  openOrNew(type, id, blank) {
    precondition(blank.id.equals(id), 'the blank must name the opened record');
    const identity = this.registry.type(type.type)?.identity;
    precondition(identity === 'keyed' || identity === 'singleton', 'open with a blank requires a keyed or singleton type');
    return this.open(type, id) ?? Draft.new(blank);
  }

  // The draft's one door (INV-14): its save as one commit, answering the result and the draft after it.
  /**
   * @template {import('./entities.js').Writable<any>} E
   * @template R
   * @param {Draft<E>} draft
   * @param {import('./refusals.js').Refusals<R>} refusals
   * @returns {Promise<{ result: import('./drafts.js').SaveResult<R>, draft: Draft<E> }>}
   */
  async save(draft, refusals) {
    const save = SaveDraft.ofDraft(draft, refusals);
    /** @type {import('./actions.js').Outcome<import('./drafts.js').Saved, R>} */
    let outcome;
    try {
      outcome = await this.perform(save);
    } catch (error) {
      if (error instanceof Fault || error instanceof PlanError || error instanceof DecodeError) throw error;
      return { result: SaveResult.failed(error), draft };
    }
    if (outcome.kind === 'refused') return { result: SaveResult.refused(outcome.refusal), draft };
    const after = draft.take(outcome.result);
    return { result: SaveResult.saved(outcome.kind === 'committed' ? outcome.receipt : null), draft: after };
  }
}

// The port over the browser engine (`platform/sync/engine.js`): the kit's gesture becomes the engine's
// `{changes, opts}`, the engine's outcome the kit's receipt, and a `too-large` refusal names the notice
// the commit wrote so the runner can dismiss it.
export class EngineReplica {
  /** @param {any} engine a started `BrowserSyncEngine` */
  constructor(engine) {
    this.engine = engine;
  }

  /**
   * @template T
   * @param {string} scope
   * @param {(views: CommitViews) => { gesture: Gesture | null, value: T }} body
   * @returns {Promise<{ outcome: CommitOutcome | null, value: T }>}
   */
  async commit(scope, body) {
    const gestureId = this.engine.newGestureId();
    const { outcome, value } = await this.engine.commit(scope, (/** @type {CommitViews} */ views) => {
      const decided = body(views);
      if (decided.gesture === null) return { gesture: null, value: decided.value };
      const { changes, atomic, hold, guards, retire, cmd, predict, local, supersede } = decided.gesture;
      const opts = { gestureId, atomic, hold, guard: guards, retire, predict,
        ...(supersede?.length ? { supersede } : {}), local: Object.fromEntries(local.map((write) => [write.key, write.value])) };
      return { gesture: { changes, opts: cmd === null ? opts : { ...opts, cmd } }, value: decided.value };
    });
    if (outcome === null) return { outcome: null, value };
    if (outcome.refused !== undefined) {
      const notice = outcome.refused === 'too-large' ? `notice:${gestureId}/0` : null;
      return { outcome: { refused: { code: outcome.refused, detail: outcome.detail ?? null, notice } }, value };
    }
    const entry = outcome.localIds.length ? this.engine.device.activeReplica.entry(outcome.localIds[0]) : undefined;
    const releaseAt = entry?.state === 'held' ? entry.releaseAt : null;
    return { outcome: { receipt: { gestureId, localIds: outcome.localIds, retired: outcome.retired,
      ...(outcome.superseded?.length ? { superseded: outcome.superseded } : {}), releaseAt } }, value };
  }

  /**
   * @param {string} scope
   * @returns {ReadViews}
   */
  read(scope) {
    const snapshot = this.engine.observe(scope).getSnapshot();
    const keyed = (/** @type {ViewRecord[]} */ records) => new Map(records.map((record) => [recordKey(record.t, record.id), record]));
    return {
      drawn: keyed(snapshot.drawn),
      stored: keyed(snapshot.stored),
      ...this.engine.readMetadata(scope),
    };
  }

  /** @param {string} gestureId */
  undo(gestureId) {
    return this.engine.undo(gestureId);
  }

  // D-8: a CSPRNG id by the type's mint, drawn again while a drawn record holds it.
  /**
   * @param {string} type
   * @param {Set<string>} taken
   * @returns {RecordID}
   */
  mintId(type, taken) {
    const definition = this.engine.registry.type(type);
    precondition(definition?.mint !== undefined, `${type} mints no ids`);
    let id = mintId(definition, this.engine.draw);
    while (taken.has(id)) id = mintId(definition, this.engine.draw);
    return id;
  }

  opaqueID() {
    return this.engine.newGestureId();
  }

  // The commit's own clock: the device clock corrected by the server offset (engine §10.4).
  physNow() {
    return this.engine.now() + this.engine.device.activeReplica.meta.serverOffsetMs;
  }

  /** @param {string} id */
  dismissNotice(id) {
    return this.engine.dismissNotice(id);
  }
}
