// @ts-check
// §10 drafts: an entity being edited, immutable, and its one save, a decider the runner alone builds
// from a draft (INV-14). Each edit and each save returns the next draft as a value.

import { Registry } from '../sync/core/registry.js';
import { Decision } from './actions.js';
import { Fields, sameJson, uniqueInByteOrder } from './entities.js';
import { Plan } from './plans.js';
import { Placement } from './reading.js';
import { Refused } from './refusals.js';
import { Valid } from './validation.js';
import { precondition } from './values.js';

/** @typedef {import('./values.js').Json} Json */
/** @typedef {import('./entities.js').RecordID} RecordID */
/** @typedef {import('./time.js').Moment} Moment */
/** @typedef {import('./actions.js').CommitReceipt} CommitReceipt */
/**
 * @template R
 * @typedef {{ kind: 'saved', receipt: CommitReceipt | null } | { kind: 'refused', refusal: R } | { kind: 'failed', error: unknown }} SaveResult
 */

/** @template {import('./entities.js').Writable<any>} E */
export class Draft {
  // Built by `Draft.new`, `Draft.opening` and the draft's own methods only.
  /**
   * @param {import('./entities.js').Id<E>} id
   * @param {E} base
   * @param {E} current
   * @param {boolean} isNew
   * @param {import('./reading.js').Placement | null} placement
   */
  constructor(id, base, current, isNew, placement) {
    this.id = id;
    this.base = base;
    this.current = current;
    this.isNew = isNew;
    this.placement = placement;
    Object.freeze(this);
  }

  // A new draft of a blank: the entity with its id and nothing a person set. A prefill is an edit after it.
  /**
   * @template {import('./entities.js').Writable<any>} E
   * @param {E} blank
   * @param {import('./reading.js').Placement | null} placed
   */
  static new(blank, placed = null) {
    precondition(blank.id.entity.isDraftable, `${blank.id.entity.type} is not Draftable`);
    precondition(placed === null || blank.id.entity.isOrdered, 'only an Ordered draft has a placement');
    return new Draft(blank.id, blank, blank, true, placed);
  }

  /**
   * @template {import('./entities.js').Writable<any>} E
   * @param {E} value
   */
  static opening(value) {
    precondition(value.id.entity.isDraftable, `${value.id.entity.type} is not Draftable`);
    return new Draft(value.id, value, value, false, null);
  }

  // The fields whose value in `current` differs from `base`, by JCS, in byte order.
  get touched() {
    const base = this.base.fields();
    const current = this.current.fields();
    return uniqueInByteOrder([...Object.keys(base), ...Object.keys(current)]).filter((name) => !sameJson(base[name], current[name]));
  }

  get isDirty() {
    return this.touched.length > 0;
  }

  /** @param {(current: E) => E} change */
  edit(change) {
    const edited = change(this.current);
    precondition(edited.id.equals(this.id), 'a draft edits its own record');
    return new Draft(this.id, this.base, edited, this.isNew, this.placement);
  }

  // §10.3 Keep mine: every touched field keeps its value, every other field takes theirs.
  /** @param {E} theirs */
  rebased(theirs) {
    const type = this.id.entity;
    precondition(type.savesGuarded === true, 'an unguarded draft cannot be rebased');
    precondition(theirs.id.equals(this.id), 'a draft rebases onto its own record');
    const current = this.current.fields();
    const kept = Object.fromEntries(this.touched.map((name) => [name, current[name] ?? null]));
    return new Draft(this.id, theirs, type.decoding(this.id, { ...theirs.fields(), ...kept }), this.isNew, this.placement);
  }

  // After a save: base and current take what the store holds, and a new draft ends when the record exists.
  /** @param {Saved} saved */
  take(saved) {
    const type = this.id.entity;
    const base = type.decoding(this.id, { ...this.base.fields(), ...saved.values });
    const current = type.decoding(this.id, { ...this.current.fields(), ...saved.values });
    return new Draft(this.id, base, current, saved.exists ? false : this.isNew, this.placement);
  }
}

// The fields a save gives the draft, as stored, and whether the record is in `stored` after it.
export class Saved {
  /**
   * @param {Record<string, Json>} values
   * @param {boolean} exists
   */
  constructor(values, exists) {
    this.values = Object.freeze({ ...values });
    this.exists = exists;
    Object.freeze(this);
  }
}

export const SaveResult = Object.freeze({
  /**
   * @param {CommitReceipt | null} receipt
   * @returns {SaveResult<never>}
   */
  saved: (receipt) => Object.freeze({ kind: 'saved', receipt }),
  /**
   * @template R
   * @param {R} refusal
   * @returns {SaveResult<R>}
   */
  refused: (refusal) => Object.freeze({ kind: 'refused', refusal }),
  /**
   * @param {unknown} error
   * @returns {SaveResult<never>}
   */
  failed: (error) => Object.freeze({ kind: 'failed', error }),
});

/**
 * @template E
 * @typedef {{ drawn: E | null, stored: E | null, folded: E | null, anchor: RecordID | null, moment: Moment,
 *   definition: import('./entities.js').Definition }} SaveDraftLoaded
 */

// §10.2 the save of a draft, and §11 an executor's own new record (`creating`).
/**
 * @template {import('./entities.js').Writable<any>} E
 * @template R
 */
export class SaveDraft {
  /**
   * @param {{ refusals: import('./refusals.js').Refusals<R>, id: import('./entities.js').Id<E>, base: E, current: E, isNew: boolean,
   *   placement: import('./reading.js').Placement | null, touched: readonly string[], creating: boolean }} parts
   */
  constructor({ refusals, id, base, current, isNew, placement, touched, creating }) {
    this.type = id.entity;
    this.refusals = refusals;
    this.id = id;
    this.base = base;
    this.current = current;
    this.isNew = isNew;
    this.placement = placement;
    this.touched = touched;
    this.creating = creating;
    Object.freeze(this);
  }

  /**
   * @template {import('./entities.js').Writable<any>} E
   * @template R
   * @param {Draft<E>} draft
   * @param {import('./refusals.js').Refusals<R>} refusals
   */
  static ofDraft(draft, refusals) {
    precondition(draft.current.id.equals(draft.id), 'a draft saves its own record');
    return new SaveDraft({ refusals, id: draft.id, base: draft.base, current: draft.current, isNew: draft.isNew,
      placement: draft.placement, touched: draft.touched, creating: false });
  }

  /**
   * @template {import('./entities.js').Writable<any>} E
   * @template R
   * @param {E} value
   * @param {import('./refusals.js').Refusals<R>} refusals
   * @param {import('./reading.js').Placement | null} placed
   */
  static creating(value, refusals, placed = null) {
    precondition(value.id.entity.isDraftable, `${value.id.entity.type} is not Draftable`);
    precondition(placed === null || value.id.entity.isOrdered, 'only an Ordered create has a placement');
    return new SaveDraft({ refusals, id: value.id, base: value, current: value, isNew: true, placement: placed,
      touched: uniqueInByteOrder(Object.keys(value.fields())), creating: true });
  }

  get scope() {
    return this.type.scope;
  }

  /**
   * @param {import('./reading.js').Reader} read
   * @returns {SaveDraftLoaded<E>}
   */
  load(read) {
    const definition = /** @type {import('./entities.js').Definition | undefined} */ (read.registry.type(this.type.type));
    precondition(definition !== undefined, `the registry lacks ${this.type.type}`);
    const repository = read.repository(this.type);
    const foldedRecord = repository.record(this.id.record, 'stored');
    const anchor = this.isNew && this.type.isOrdered ? repository.anchor(this.placement ?? Placement.bottom) : null;
    return {
      drawn: repository.find(this.id, 'drawn'),
      stored: repository.find(this.id, 'stored'),
      folded: foldedRecord ? this.type.decode(Fields.record(foldedRecord)) : null,
      anchor,
      moment: read.moment,
      definition,
    };
  }

  /**
   * @param {SaveDraftLoaded<E>} loaded
   * @returns {Decision<Saved, R>}
   */
  decide(loaded) {
    const { definition, moment } = loaded;
    if (this.creating && (loaded.drawn !== null || loaded.stored !== null)) return this.refused('id-taken');
    if (definition.wholePut === true) {
      const valid = new Valid(this.current, moment);
      const plan = new Plan();
      plan.create(valid);
      return Decision.write(plan, new Saved(valid.value.fields(), true));
    }
    const minted = definition.identity === 'minted';
    if (this.touched.length === 0 && !(this.isNew && minted)) return Decision.unchanged(new Saved({}, loaded.stored !== null));
    const gone = minted ? !this.isNew || loaded.stored !== null
      : definition.identity === 'keyed' && definition.life === true && !this.isNew && loaded.stored === null;
    if (loaded.drawn === null && gone) return this.refused('unknown-record');
    if (minted && loaded.stored === null) {
      const valid = new Valid(this.current, moment);
      const plan = new Plan();
      if (this.type.isOrdered) plan.insert(valid, loaded.anchor);
      else plan.create(valid);
      const stamped = Object.fromEntries(Object.entries(valid.value.fields()).map(([name, value]) =>
        [name, value === null && definition.field(name)?.kind === 'time' ? moment.now.ms : value]));
      return Decision.write(plan, new Saved(stamped, true));
    }
    if (!minted && loaded.drawn === null) {
      const valid = new Valid(this.current, moment, this.isNew ? undefined : [...this.touched]);
      const plan = new Plan();
      plan.create(valid, { fields: [...this.touched], from: this.base });
      const written = Object.fromEntries(this.touched.map((name) => [name, valid.value.fields()[name] ?? null]));
      return Decision.write(plan, new Saved({ ...(loaded.folded ?? this.base).fields(), ...written }, true));
    }
    const valid = new Valid(this.current, moment, [...this.touched]);
    const stored = loaded.stored?.fields() ?? {};
    const validated = valid.value.fields();
    const settled = Object.fromEntries(this.touched.map((name) => [name, validated[name] ?? null]));
    const changed = this.touched.filter((name) => !sameJson(stored[name], validated[name]));
    if (changed.length === 0) return Decision.unchanged(new Saved(settled, loaded.stored !== null));
    const base = this.base.fields();
    const moved = changed.some((name) => Registry.isLattice(definition.field(name)?.kind) && !sameJson(stored[name], base[name]));
    if (this.type.savesGuarded === true && moved) return this.refused('stale');
    const plan = new Plan();
    plan.update(valid, { fields: changed, from: this.base, guarded: this.type.savesGuarded === true });
    return Decision.write(plan, new Saved(settled, true));
  }

  /** @param {string} code */
  refused(code) {
    return Decision.refuse(this.refusals.ofRefused(new Refused(code, this.id.ref, null, 'predicted')));
  }
}
