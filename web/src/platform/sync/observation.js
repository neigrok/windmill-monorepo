import { compareBytes } from './core/encoding.js';
import { frozen } from './store.js';
import { jcsBytes } from '../../../../packages/api-contract/sync/reference/core/jcs.js';
import { recordKey } from '../../../../packages/api-contract/sync/reference/core/rows.js';
import { undoOffers } from '../../../../packages/api-contract/sync/reference/client/hold.js';
import { effectsOf } from '../../../../packages/api-contract/sync/reference/client/projections.js';
import { noticesInScope } from '../../../../packages/api-contract/sync/reference/client/refusal.js';
import { foldDelta, viewRecord } from '../../../../packages/api-contract/sync/reference/client/views.js';

const PENDING = new Set(['ready', 'sent', 'acked']);
const ENVELOPE = ['seq', 'rc', 'ru'];

// A pending entry as the observation folded it: the deltas its active effects draw in the scope, in order,
// and the record keys they name.
class FoldedEntry {
  constructor(entry, deltas, signature) {
    this.source = entry;
    this.signature = signature;
    this.order = entry.commitOrder;
    this.held = entry.state === 'held';
    this.deltas = deltas;
    this.keys = deltas.map((delta) => recordKey(delta.t, delta.id));
  }

  static of(entry, scope) {
    const deltas = effectsOf(entry, { active: true }).filter((effect) => effect.scope === scope).flatMap(({ d }) => d);
    return new FoldedEntry(entry, deltas, JSON.stringify([entry.state === 'held', entry.commitOrder, deltas]));
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

// One scope's drawn and stored records, kept between publications: a publication folds again only the records
// whose confirmed row changed identity or whose pending entries changed.
export class ScopeObservation {
  constructor(scope, registry, { firstPullComplete, notify }) {
    Object.assign(this, { scope, registry, firstPullComplete, notify });
    this.listeners = new Set();
    this.replicaId = null;
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  refresh(replica) {
    if (replica.id !== this.replicaId) {
      this.replicaId = replica.id;
      this.confirmed = {};
      this.entries = new Map();
      this.ordered = [];
      this.drawn = new Map();
      this.stored = new Map();
      this.order = new RecordOrder();
    }
    const changed = new Set();
    this.readConfirmed(replica, changed);
    this.readEntries(replica, changed);
    this.fold(changed);
    const records = (view) => this.order.keys.filter((key) => view.has(key)).map((key) => view.get(key));
    this.snapshot = frozen({ replica: replica.id, drawn: records(this.drawn), stored: records(this.stored),
      notices: structuredClone(noticesInScope(replica, this.scope)),
      undoOffers: undoOffers(replica, this.scope),
      firstPullComplete: this.firstPullComplete(replica) });
    this.notify(this.listeners);
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
      if (!(entry.state === 'held' || PENDING.has(entry.state))) continue;
      const previous = this.entries.get(entry.localId);
      if (previous?.source === entry) { entries.set(entry.localId, previous); continue; }
      const folded = FoldedEntry.of(entry, this.scope);
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
    const drawn = new Map(), stored = new Map(), held = new Set();
    for (const key of changed) {
      const row = this.confirmed[key];
      if (!row) continue;
      const record = viewRecord(row);
      drawn.set(key, record);
      stored.set(key, record);
    }
    for (const entry of this.ordered) entry.keys.forEach((key, index) => {
      if (!changed.has(key)) return;
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
      const record = drawnRecord ?? storedRecord;
      if (record && !present) { this.order.place(key, record); added.add(key); }
      if (!record && present) removed.add(key);
    }
    this.order.update(added, removed);
  }
}
