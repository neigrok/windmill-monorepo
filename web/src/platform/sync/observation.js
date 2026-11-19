import { compareBytes } from './core/encoding.js';
import { frozen } from './store.js';
import { jcsBytes } from '../../../../packages/api-contract/sync/reference/core/jcs.js';
import { recordKey } from '../../../../packages/api-contract/sync/reference/core/rows.js';
import { undoOffers } from '../../../../packages/api-contract/sync/reference/client/hold.js';
import { effectsOf } from '../../../../packages/api-contract/sync/reference/client/projections.js';
import { noticesInScope, noticesOfProduct } from '../../../../packages/api-contract/sync/reference/client/refusal.js';
import { foldDelta, viewRecord } from '../../../../packages/api-contract/sync/reference/client/views.js';

const QUEUED = ['held', 'ready', 'sent', 'acked'];
const ENVELOPE = ['seq', 'rc', 'ru'];

// A queued entry as the observation folded it: its state, whether it belongs to or draws in the scope, the
// deltas its active effects draw there, in order, and the record keys they name.
class FoldedEntry {
  constructor(entry, scope) {
    const effects = effectsOf(entry, { active: true }).filter((effect) => effect.scope === scope);
    this.source = entry;
    this.state = entry.state;
    this.order = entry.commitOrder;
    this.held = entry.state === 'held';
    this.counted = entry.scope === scope || effects.length > 0;
    this.deltas = effects.flatMap(({ d }) => d);
    this.keys = this.deltas.map((delta) => recordKey(delta.t, delta.id));
  }

  get signature() {
    return (this.encoded ??= JSON.stringify([this.state, this.order, this.counted, this.deltas]));
  }
}

// One holder's use of an observation: its snapshot and the listeners it registered, until it releases them.
class ObservationHold {
  constructor(observation) {
    this.observation = observation;
    this.registered = new Set();
    this.released = false;
  }

  getSnapshot = () => this.observation.snapshot;

  subscribe = (listener) => {
    if (this.released) return () => {};
    const registered = (value) => listener(value);
    this.registered.add(registered);
    this.observation.listeners.add(registered);
    return () => {
      this.registered.delete(registered);
      this.observation.listeners.delete(registered);
    };
  };

  release() {
    if (this.released) return;
    this.released = true;
    for (const registered of this.registered) this.observation.listeners.delete(registered);
    this.registered.clear();
    this.observation.letGo();
  }
}

// The keys of the scope's records in compareRecords order, each id's JCS bytes encoded once.
class RecordOrder {
  constructor() {
    this.keys = [];
    this.sortKeys = new Map();
  }

  compare = (a, b) => {
    const left = this.sortKeys.get(a), right = this.sortKeys.get(b);
    if (left.t !== right.t) return left.t < right.t ? -1 : 1;
    return compareBytes(left.id, right.id);
  };

  update(added, removed) {
    if (!added.size && !removed.size) return;
    const kept = removed.size ? this.keys.filter((key) => !removed.has(key)) : this.keys;
    const incoming = [...added].sort(this.compare);
    const merged = [];
    let i = 0, j = 0;
    while (i < kept.length || j < incoming.length) {
      if (j === incoming.length || (i < kept.length && this.compare(kept[i], incoming[j]) < 0)) merged.push(kept[i++]);
      else merged.push(incoming[j++]);
    }
    for (const key of removed) this.sortKeys.delete(key);
    this.keys = merged;
  }

  place(key, record) {
    if (!this.sortKeys.has(key)) this.sortKeys.set(key, { t: record.t, id: jcsBytes(record.id) });
  }
}

// What the engine publishes to its holders: a snapshot each replica publication refreshes, which lives while a hold
// is unreleased.
class Observation {
  constructor({ notify, idle }) {
    Object.assign(this, { notify, idle });
    this.holders = 0;
    this.listeners = new Set();
  }

  hold() {
    this.holders += 1;
    return new ObservationHold(this);
  }

  letGo() {
    this.holders -= 1;
    if (this.holders === 0) this.idle();
  }

  publish(snapshot) {
    this.snapshot = frozen(snapshot);
    this.notify(this.listeners);
  }
}

// One scope's drawn and stored records, kept between publications: a publication folds again only the records
// whose confirmed row changed identity or whose queued entries changed.
export class ScopeObservation extends Observation {
  constructor(scope, registry, { firstPullComplete, notify, idle }) {
    super({ notify, idle });
    Object.assign(this, { scope, registry, firstPullComplete });
    this.replicaId = null;
  }

  refresh(replica) {
    if (replica.id !== this.replicaId) {
      this.replicaId = replica.id;
      this.confirmed = {};
      this.entries = new Map();
      this.ordered = [];
      this.drawn = new Map();
      this.stored = new Map();
      this.pending = new Set();
      this.order = new RecordOrder();
    }
    const changed = new Set();
    this.readConfirmed(replica, changed);
    this.readEntries(replica, changed);
    this.fold(changed);
    const records = (view) => this.order.keys.filter((key) => view.has(key)).map((key) => view.get(key));
    const outbox = Object.fromEntries(QUEUED.map((state) => [state, 0]));
    for (const entry of this.entries.values()) if (entry.counted) outbox[entry.state] += 1;
    this.publish({ replica: replica.id, drawn: records(this.drawn), stored: records(this.stored),
      pending: this.order.keys.filter((key) => this.pending.has(key)).map((key) => this.drawn.get(key)), outbox,
      loaded: !replica.confirmed[this.scope] || replica.loadedCaches?.has(`confirmed:${this.scope}`) === true,
      notices: structuredClone(noticesInScope(replica, this.scope)),
      undoOffers: undoOffers(replica, this.scope),
      firstPullComplete: this.firstPullComplete(replica) });
  }

  readConfirmed(replica, changed) {
    const current = replica.confirmed[this.scope] ?? {};
    if (current === this.confirmed) return;
    for (const key of Object.keys(current)) if (current[key] !== this.confirmed[key]) changed.add(key);
    for (const key of Object.keys(this.confirmed)) if (!Object.hasOwn(current, key)) changed.add(key);
    this.confirmed = current;
  }

  readEntries(replica, changed) {
    const entries = new Map();
    let moved = false;
    for (const entry of replica.outbox) {
      if (!QUEUED.includes(entry.state)) continue;
      const previous = this.entries.get(entry.localId);
      if (previous?.source === entry) { entries.set(entry.localId, previous); continue; }
      const folded = new FoldedEntry(entry, this.scope);
      if (previous?.signature === folded.signature) {
        previous.source = entry;
        entries.set(entry.localId, previous);
        continue;
      }
      for (const key of [...folded.keys, ...previous?.keys ?? []]) changed.add(key);
      entries.set(entry.localId, folded);
      moved = true;
    }
    for (const [localId, previous] of this.entries) {
      if (entries.has(localId)) continue;
      for (const key of previous.keys) changed.add(key);
      moved = true;
    }
    this.entries = entries;
    if (moved) this.ordered = [...entries.values()].sort((a, b) => a.order - b.order);
  }

  fold(changed) {
    if (!changed.size) return;
    const drawn = new Map(), stored = new Map(), held = new Set(), touched = new Set();
    for (const key of changed) {
      const row = this.confirmed[key];
      if (!row) continue;
      const record = viewRecord(row);
      drawn.set(key, record);
      stored.set(key, record);
    }
    for (const entry of this.ordered) entry.keys.forEach((key, index) => {
      if (!changed.has(key)) return;
      touched.add(key);
      foldDelta(drawn, this.registry, entry.deltas[index]);
      if (entry.held) held.add(key);
      else foldDelta(stored, this.registry, entry.deltas[index]);
    });
    const added = new Set(), removed = new Set();
    for (const key of changed) {
      const present = this.drawn.has(key) || this.stored.has(key);
      const row = this.confirmed[key];
      const envelope = Object.fromEntries(ENVELOPE.filter((name) => row?.[name] !== undefined).map((name) => [name, row[name]]));
      const shown = (record) => record && frozen({ ...record, ...envelope });
      const drawnRecord = shown(drawn.get(key));
      const storedRecord = held.has(key) ? shown(stored.get(key)) : drawnRecord;
      for (const [view, record] of [[this.drawn, drawnRecord], [this.stored, storedRecord]]) {
        if (record) view.set(key, record);
        else view.delete(key);
      }
      if (touched.has(key)) this.pending.add(key);
      else this.pending.delete(key);
      const record = drawnRecord ?? storedRecord;
      if (record && !present) { this.order.place(key, record); added.add(key); }
      if (!record && present) removed.add(key);
    }
    this.order.update(added, removed);
  }
}

// One product's notices in every scope (engine.md §7.6), each the durable notice whole: a publication keeps the snapshot
// while the replica is the same and holds the same notices, which a store read shares unchanged from one to the next.
export class ProductNotices extends Observation {
  constructor(product, registry, { notify, idle }) {
    super({ notify, idle });
    Object.assign(this, { product, registry });
    this.read = null;
  }

  refresh(replica) {
    const notices = noticesOfProduct(replica, this.registry, this.product);
    const read = this.read;
    if (read?.replica === replica.id && read.notices.length === notices.length && read.notices.every((notice, index) => notice === notices[index])) return;
    this.read = { replica: replica.id, notices };
    this.publish({ replica: replica.id, notices: structuredClone(notices) });
  }
}
