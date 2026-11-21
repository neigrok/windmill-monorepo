// @ts-check
// §10 drafts: an entity being edited, immutable, and its one save, a decider the runner alone builds
// from a draft (INV-14). Each edit and each save returns the next draft as a value.

import { Registry } from '../../../../packages/api-contract/sync/reference/core/registry.js';
import { creatableFault } from '../../../../packages/api-contract/sync/reference/core/restore.js';
import { Decision } from './actions.js';
import { Fields, sameJson, uniqueInByteOrder } from './entities.js';
import { Plan, UndoRecipe, UndoTarget } from './plans.js';
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
   * @param {string} [scope]
   */
  constructor(id, base, current, isNew, placement, scope = id.entity.boundScope()) {
    this.scope = id.entity.boundScope(scope);
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
   * @param {string | null} [scope]
   */
  static new(blank, placed = null, scope = blank.id.entity.scope) {
    precondition(blank.id.entity.isDraftable, `${blank.id.entity.type} is not Draftable`);
    precondition(placed === null || blank.id.entity.isOrdered, 'only an Ordered draft has a placement');
    return new Draft(blank.id, blank, blank, true, placed, blank.id.entity.boundScope(scope));
  }

  /**
   * @template {import('./entities.js').Writable<any>} E
   * @param {E} value
   * @param {string | null} [scope]
   */
  static opening(value, scope = value.id.entity.scope) {
    precondition(value.id.entity.isDraftable, `${value.id.entity.type} is not Draftable`);
    return new Draft(value.id, value, value, false, null, value.id.entity.boundScope(scope));
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
    return new Draft(this.id, this.base, edited, this.isNew, this.placement, this.scope);
  }

  // §10.3 Keep mine: every touched field keeps its value, every other field takes theirs.
  /** @param {E} theirs */
  rebased(theirs) {
    const type = this.id.entity;
    precondition(type.savesGuarded === true, 'an unguarded draft cannot be rebased');
    precondition(theirs.id.equals(this.id), 'a draft rebases onto its own record');
    const current = this.current.fields();
    const kept = Object.fromEntries(this.touched.map((name) => [name, current[name] ?? null]));
    return new Draft(this.id, theirs, type.decoding(this.id, { ...theirs.fields(), ...kept }), this.isNew, this.placement, this.scope);
  }

  // After a save: base and current take what the store holds, and a new draft ends when the record exists.
  /** @param {Saved} saved */
  take(saved) {
    const type = this.id.entity;
    const base = type.decoding(this.id, { ...this.base.fields(), ...saved.values });
    const current = type.decoding(this.id, { ...this.current.fields(), ...saved.values });
    return new Draft(this.id, base, current, saved.exists ? false : this.isNew, this.placement, this.scope);
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
 *   definition: import('./entities.js').Definition, restoreCommand: string | null }} SaveDraftLoaded
 */

// §10.2 the save of a draft, and §11 an executor's own new record (`creating`).
/**
 * @template {import('./entities.js').Writable<any>} E
 * @template R
 */
export class SaveDraft {
  /**
   * @param {{ refusals: import('./refusals.js').Refusals<R>, id: import('./entities.js').Id<E>, base: E, current: E, isNew: boolean,
   *   placement: import('./reading.js').Placement | null, touched: readonly string[], creating: boolean, scope?: string }} parts
   */
  constructor({ refusals, id, base, current, isNew, placement, touched, creating, scope = id.entity.boundScope() }) {
    this.scope = id.entity.boundScope(scope);
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
   * @param {string} [scope]
   */
  static ofDraft(draft, refusals, scope = draft.scope) {
    precondition(scope === draft.scope, 'a draft saves in its bound scope');
    precondition(draft.current.id.equals(draft.id), 'a draft saves its own record');
    return new SaveDraft({ refusals, id: draft.id, base: draft.base, current: draft.current, isNew: draft.isNew,
      placement: draft.placement, touched: draft.touched, creating: false, scope });
  }

  /**
   * @template {import('./entities.js').Writable<any>} E
   * @template R
   * @param {E} value
   * @param {import('./refusals.js').Refusals<R>} refusals
   * @param {import('./reading.js').Placement | null} placed
   * @param {string | null} [scope]
   */
  static creating(value, refusals, placed = null, scope = value.id.entity.scope) {
    precondition(value.id.entity.isDraftable, `${value.id.entity.type} is not Draftable`);
    precondition(placed === null || value.id.entity.isOrdered, 'only an Ordered create has a placement');
    return new SaveDraft({ refusals, id: value.id, base: value, current: value, isNew: true, placement: placed,
      touched: uniqueInByteOrder(Object.keys(value.fields())), creating: true, scope: value.id.entity.boundScope(scope) });
  }

  // §10.2: a save of a type that saves reversibly opts into Undo of an act, so the runner runs it as one.
  get reversible() {
    return this.type.savesReversibly;
  }

  /**
   * @param {import('./reading.js').Reader} read
   * @returns {SaveDraftLoaded<E>}
   */
  load(read) {
    precondition(read.scope === this.scope, 'a decider loads its bound scope');
    const definition = /** @type {import('./entities.js').Definition | undefined} */ (read.registry.type(this.type.type));
    precondition(definition !== undefined, `the registry lacks ${this.type.type}`);
    const restore = [...read.registry.commands.values()].find((command) => command.engine === 'restore' && command.scope === definition.scope
      && command.predicts.includes(this.type.type));
    precondition(!this.reversible || restore !== undefined, `${this.type.type}: a reversible save needs its scope kind's restore command`);
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
      restoreCommand: this.reversible && restore ? restore.name : null,
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
      precondition(!this.reversible, `${this.type.type}: a whole-put save is not reversible`);
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
      this.optInto(plan, loaded, Object.keys(valid.value.fields()));
      const stamped = Object.fromEntries(Object.entries(valid.value.fields()).map(([name, value]) =>
        [name, value === null && definition.field(name)?.kind === 'time' ? moment.now.ms : value]));
      return Decision.write(plan, new Saved(stamped, true));
    }
    if (!minted && loaded.drawn === null) {
      const valid = new Valid(this.current, moment, this.isNew ? undefined : [...this.touched]);
      const plan = new Plan();
      plan.create(valid, { fields: [...this.touched], from: this.base });
      this.optInto(plan, loaded, this.touched);
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
    this.optInto(plan, loaded, changed);
    return Decision.write(plan, new Saved(settled, true));
  }

  // A reversible save's Undo recipe, named on its plan. A record the save creates where no record was, and a
  // delete can take it back, goes again while its own writes are all that changed it. Otherwise each written
  // field or text takes back its earlier value, an unset one the draft base's, and a record the save brings
  // back to life (present again) takes back its life, dead when unset.
  /**
   * @param {Plan} plan
   * @param {SaveDraftLoaded<E>} loaded
   * @param {readonly string[]} written
   */
  optInto(plan, loaded, written) {
    const { definition, restoreCommand } = loaded;
    if (restoreCommand === null) return;
    if (loaded.drawn === null && loaded.folded === null && creatableFault(definition) === null) {
      plan.undoBy(UndoRecipe.createdRecord(restoreCommand, this.id));
      return;
    }
    const base = this.base.fields();
    const revives = loaded.drawn === null && definition.life === true && (definition.identity === 'keyed' || definition.revivable === true);
    plan.undoBy(UndoRecipe.fields(restoreCommand, [
      ...(revives ? [{ target: UndoTarget.life(this.id), defaultValue: 'dead' }] : []),
      ...written.map((name) => {
        const field = definition.field(name);
        precondition(field?.writer === 'client' && (field.kind === 'lww' || field.kind === 'text'), `${this.type.type}.${name}: a reversible save writes client fields and texts`);
        return { target: field.kind === 'text' ? UndoTarget.text(this.id, name) : UndoTarget.field(this.id, name), defaultValue: base[name] ?? null };
      }),
    ]));
  }

  /** @param {string} code */
  refused(code) {
    return Decision.refuse(this.refusals.ofRefused(new Refused(code, this.id.ref, null, 'predicted')));
  }
}
