// @ts-check
// §7 reading: the two views a reader sees, repositories over them, capacity over `stored`, and the
// placement a new member resolves against `stored`. `stored` decides; `drawn` draws (INV-9).

import { compareJcs, jcs } from '../../../../packages/api-contract/sync/reference/core/jcs.js';
import { isVisible, recordKey } from '../../../../packages/api-contract/sync/reference/core/rows.js';
import { Fields, compareText } from './entities.js';
import { Refused } from './refusals.js';
import { precondition } from './values.js';

/** @typedef {import('./values.js').Json} Json */
/** @typedef {import('./entities.js').RecordID} RecordID */
/** @typedef {import('./entities.js').RecordRef} RecordRef */
/** @typedef {import('./entities.js').ViewRecord} ViewRecord */
/** @typedef {import('./time.js').Moment} Moment */
/** @typedef {import('../../../../packages/api-contract/sync/reference/core/registry.js').Registry} Registry */
/** @typedef {'drawn' | 'stored'} ViewMode */
/** @typedef {{ records: ViewRecord[], references: Map<string, Map<string, ViewRecord[]>> }} ViewTypeIndex */
/** @typedef {{ kind: 'top' } | { kind: 'bottom' } | { kind: 'below', id: RecordID }} Placement */
/** @typedef {{ gestureId: string, command: import('./plans.js').Command, canSupersede: boolean, isAdmitted?: boolean }} QueuedCommand */
/** @typedef {{ epoch: string | null, cleanSeq: number | null }} ScopeCheckpoint */
/** @typedef {{ t: string, id: RecordID, born: string }} SpentId */
/** @typedef {{ get(key: string): ViewRecord | undefined }} ConfirmedRows the scope's confirmed records by record key */
/**
 * @typedef {{ spent?: SpentId[], devices?: Record<string, Json>, firstPullComplete?: boolean, actor?: string, isAnonymous?: boolean,
 *   commands?: QueuedCommand[], checkpoint?: ScopeCheckpoint, mintId?: (type: string) => RecordID,
 *   opaqueID?: () => string, assertOpen?: () => void }} ViewMetadata
 */

export const Placement = Object.freeze({
  top: Object.freeze({ kind: /** @type {const} */ ('top') }),
  bottom: Object.freeze({ kind: /** @type {const} */ ('bottom') }),
  /** @param {RecordID} id */
  below: (id) => Object.freeze({ kind: /** @type {const} */ ('below'), id }),
});

// What a reader reads: one scope's views, confirmed records, spent ids, commands and checkpoint, with its
// product's device rows and the identity mints a commit offers.
export class Views {
  /** @type {Record<ViewMode, Map<string, ViewTypeIndex>>} */
  #indexes = { drawn: new Map(), stored: new Map() };

  /**
   * @param {Registry} registry
   * @param {{ drawn: Map<string, ViewRecord>, stored: Map<string, ViewRecord>, confirmed?: ConfirmedRows } & ViewMetadata} source
   */
  constructor(registry, { drawn, stored, confirmed = new Map(), spent = [], devices = {}, firstPullComplete = true,
    actor = '', isAnonymous = false, commands = [], checkpoint = { epoch: null, cleanSeq: null }, mintId, opaqueID, assertOpen = () => {} }) {
    this.assertOpen = assertOpen;
    this.registry = registry;
    this.drawn = drawn;
    this.stored = stored;
    this.confirmed = confirmed;
    this.spent = new Map(spent.map((row) => [recordKey(row.t, row.id), row.born]));
    this.devices = devices;
    this.firstPullComplete = firstPullComplete;
    this.actor = actor;
    this.isAnonymous = isAnonymous;
    this.commands = commands;
    this.checkpoint = checkpoint;
    this.mintId = mintId ?? null;
    this.mintOpaqueId = opaqueID ?? null;
    for (const view of /** @type {const} */ (['drawn', 'stored'])) {
      for (const record of this[view].values()) {
        const definition = registry.type(record.t);
        if (!isVisible(definition, record)) continue;
        let index = this.#indexes[view].get(record.t);
        if (!index) {
          index = { records: [], references: new Map(definition.fieldNames((/** @type {{ ref?: string }} */ field) => field.ref !== undefined)
            .map((/** @type {string} */ name) => [name, new Map()])) };
          this.#indexes[view].set(record.t, index);
        }
        index.records.push(record);
        for (const [name, references] of index.references) {
          const value = record.f?.[name]?.[0];
          if (value === undefined) continue;
          const key = jcs(value);
          const members = references.get(key) ?? [];
          members.push(record);
          references.set(key, members);
        }
      }
    }
    Object.freeze(this);
  }

  /**
   * @param {Registry} registry
   * @param {{ drawn: ViewRecord[], stored: ViewRecord[], confirmed?: ViewRecord[] } & ViewMetadata} source
   */
  static ofRecords(registry, { drawn, stored, confirmed = [], ...rest }) {
    const keyed = (/** @type {ViewRecord[]} */ records) => new Map(records.map((record) => [recordKey(record.t, record.id), record]));
    return new Views(registry, { drawn: keyed(drawn), stored: keyed(stored), confirmed: keyed(confirmed), ...rest });
  }

  // The record of a view, visible or not, or undefined.
  /**
   * @param {ViewMode} view
   * @param {string} type
   * @param {RecordID} id
   */
  record(view, type, id) {
    this.assertOpen();
    return this[view].get(recordKey(type, id));
  }

  // The visible records of a type in a view (engine §7.6).
  /**
   * @param {ViewMode} view
   * @param {string} type
   */
  visible(view, type) {
    this.assertOpen();
    return [...(this.#indexes[view].get(type)?.records ?? [])];
  }

  /**
   * @param {ViewMode} view
   * @param {string} type
   * @param {string} via
   * @param {RecordID} id
   */
  referencing(view, type, via, id) {
    this.assertOpen();
    const key = jcs(id);
    const index = this.#indexes[view].get(type);
    if (!index) return [];
    const references = index.references.get(via);
    if (references) return [...(references.get(key) ?? [])];
    return this.visible(view, type).filter((record) => {
      const value = record.f?.[via]?.[0];
      return value !== undefined && jcs(value) === key;
    });
  }

  // The born of the scope's spent id of a record (engine §7.5), or null.
  /**
   * @param {string} type
   * @param {RecordID} id
   */
  spentBorn(type, id) {
    this.assertOpen();
    return this.spent.get(recordKey(type, id)) ?? null;
  }

  /** @param {string} key */
  device(key) {
    this.assertOpen();
    return Object.hasOwn(this.devices, key) ? /** @type {Json} */ (this.devices[key]) : null;
  }

  /** @param {string} type */
  mint(type) {
    this.assertOpen();
    precondition(this.mintId !== null, 'ids are minted inside a commit only');
    return this.mintId(type);
  }

  opaqueID() {
    this.assertOpen();
    precondition(this.mintOpaqueId !== null, 'opaque ids are minted inside a commit only');
    return this.mintOpaqueId();
  }
}

// §7.1: valid only inside one run or read.
export class Reader {
  /**
   * @param {Views} views
   * @param {string} scope
   * @param {Moment} moment
   */
  constructor(views, scope, moment) {
    this.views = views;
    this.scope = scope;
    this.moment = moment;
    Object.freeze(this);
  }

  get registry() {
    this.views.assertOpen();
    return this.views.registry;
  }

  get actor() { this.views.assertOpen(); return this.views.actor; }
  get isAnonymous() { this.views.assertOpen(); return this.views.isAnonymous; }

  /**
   * @template E
   * @param {import('./entities.js').EntityType<E>} type
   */
  repository(type) {
    const definition = this.registry.type(type.type);
    precondition((type.scope === null || type.scope === this.scope) && definition !== undefined && definition.scope === this.registry.scopeKindOf(this.scope),
      `${type.type} is outside ${this.scope}`);
    return new Repository(type, this.views);
  }

  /** @param {string} key */
  device(key) {
    return this.views.device(key);
  }

  /** @param {string} prefix */
  devices(prefix) {
    this.views.assertOpen();
    return Object.fromEntries(Object.entries(this.views.devices).filter(([key]) => key.startsWith(prefix)));
  }

  /**
   * @template E
   * @param {import('./entities.js').EntityType<E>} type
   * @param {import('./entities.js').Id<E>} id
   */
  confirmed(type, id) {
    this.views.assertOpen();
    this.repository(type);
    return this.views.confirmed.get(recordKey(type.type, id.record)) ?? null;
  }

  commands() { this.views.assertOpen(); return this.views.commands; }
  checkpoint() { this.views.assertOpen(); return this.views.checkpoint; }

  firstPullComplete() {
    this.views.assertOpen();
    return this.views.firstPullComplete;
  }
}

/** @template E */
export class Repository {
  /**
   * @param {import('./entities.js').EntityType<E>} type
   * @param {Views} views
   */
  constructor(type, views) {
    this.type = type;
    this.views = views;
    Object.freeze(this);
  }

  /**
   * @param {import('./entities.js').Id<E>} id
   * @param {ViewMode} view
   */
  find(id, view) {
    const record = this.record(id.record, view);
    if (!record || !isVisible(this.views.registry.type(this.type.type), record)) return null;
    return this.type.decode(Fields.record(record));
  }

  /** @param {ViewMode} view */
  all(view) {
    return Repository.decode(this.type, this.views.visible(view, this.type.type));
  }

  // The visible records whose `via` field names the parent, in order (ER-12).
  /**
   * @param {import('./entities.js').Id<any>} parent
   * @param {string} via
   * @param {ViewMode} view
   */
  children(parent, via, view) {
    return Repository.decode(this.type, this.views.referencing(view, this.type.type, via, parent.record));
  }

  capacity() {
    return new Capacity(this.type, this.views.visible('stored', this.type.type), this.views.registry);
  }

  // §7.2: the born the device keeps of a record deleted elsewhere once its row is gone (engine §7.5), in neither
  // view; null for any other id, one the device never knew included.
  /** @param {import('./entities.js').Id<E>} id */
  spentBorn(id) {
    return this.views.spentBorn(this.type.type, id.record);
  }

  // The raw record of a view, visible or not (the folded record, ER-3).
  /**
   * @param {RecordID} id
   * @param {ViewMode} view
   */
  record(id, view) {
    return this.views.record(view, this.type.type, id);
  }

  // §7.5: top anchors below nothing, below(x) below x, bottom below the last stored member, held or not.
  /**
   * @param {Placement} placement
   * @returns {RecordID | null}
   */
  anchor(placement) {
    precondition(this.type.orderField !== null, `${this.type.type} is unordered`);
    if (placement.kind === 'top') return null;
    if (placement.kind === 'below') return placement.id;
    const members = Repository.ordered(this.type, this.views.visible('stored', this.type.type));
    return members.at(-1)?.id ?? null;
  }

  /**
   * @template E
   * @param {import('./entities.js').EntityType<E>} type
   * @param {ViewRecord[]} records
   */
  static decode(type, records) {
    return Repository.ordered(type, records).map((record) => type.decode(Fields.record(record)));
  }

  // §7.2: an Ordered type by its key, then its id, both by bytes; any other type by id bytes.
  /**
   * @param {import('./entities.js').EntityType<any>} type
   * @param {ViewRecord[]} records
   */
  static ordered(type, records) {
    const keyOf = (/** @type {ViewRecord} */ record) => {
      const key = type.orderField === null ? undefined : record.f?.[type.orderField]?.[0];
      return typeof key === 'string' ? key : '';
    };
    return [...records].sort((a, b) => compareText(keyOf(a), keyOf(b)) || compareJcs(a.id, b.id));
  }
}

// §7.3: the slots a type uses in `stored`, so a held delete still occupies its slot.
export class Capacity {
  /**
   * @param {import('./entities.js').EntityType<any>} type
   * @param {ViewRecord[]} stored
   * @param {Registry} registry
   */
  constructor(type, stored, registry) {
    const definition = registry.type(type.type);
    precondition(definition?.cap !== undefined, `${type.type} has no cap`);
    this.type = type.type;
    this.used = stored.filter((record) => record.t === type.type && isVisible(definition, record)).length;
    this.cap = /** @type {number} */ (definition.cap);
    Object.freeze(this);
  }

  get isFull() {
    return this.used >= this.cap;
  }

  // The growth rule (engine §6.1 step 12): a plan growing the type past its cap is refused before commit.
  /**
   * @param {number} growing
   * @param {RecordRef | null} subject
   */
  refusal(growing, subject) {
    if (growing <= 0 || this.used + growing <= this.cap) return null;
    return new Refused('cap', subject, { type: this.type, cap: this.cap }, 'predicted');
  }
}
