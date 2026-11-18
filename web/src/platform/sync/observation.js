import { compareBytes } from './core/encoding.js';
import { frozen } from './store.js';
import { jcsBytes } from '../../../../packages/api-contract/sync/reference/core/jcs.js';
import { recordKey } from '../../../../packages/api-contract/sync/reference/core/rows.js';
import { deltasOf } from '../../../../packages/api-contract/sync/reference/client/dependents.js';
import { undoOffers } from '../../../../packages/api-contract/sync/reference/client/hold.js';
import { foldDelta, viewRecord } from '../../../../packages/api-contract/sync/reference/client/views.js';

const PENDING = new Set(['ready', 'sent', 'acked']);
const ENVELOPE = ['seq', 'rc', 'ru'];

class FoldedEntry {
  constructor(entry, signature) {
    this.signature = signature;
    this.order = entry.commitOrder;
    this.held = entry.state === 'held';
    this.deltas = deltasOf(entry);
    this.keys = this.deltas.map((delta) => recordKey(delta.t, delta.id));
  }

  static signatureOf(entry) {
    return JSON.stringify([entry.state === 'held', entry.commitOrder, entry.intent.d, entry.predict]);
  }
}

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
    const records = (view) => this.order.keys.flatMap((key) => view.has(key) ? [view.get(key)] : []);
    this.snapshot = frozen({ replica: replica.id, drawn: records(this.drawn), stored: records(this.stored),
      notices: structuredClone(replica.notices.filter((notice) => notice.scope === this.scope)),
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
      if (entry.scope !== this.scope || !(entry.state === 'held' || PENDING.has(entry.state))) continue;
      const signature = FoldedEntry.signatureOf(entry);
      const previous = this.entries.get(entry.localId);
      if (previous?.signature === signature) { entries.set(entry.localId, previous); continue; }
      const folded = new FoldedEntry(entry, signature);
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
    const views = new Map();
    for (const key of changed) {
      const row = this.confirmed[key];
      const base = row ? [[key, viewRecord(row)]] : [];
      views.set(key, { drawn: new Map(base), stored: new Map(base) });
    }
    for (const entry of this.ordered) entry.keys.forEach((key, index) => {
      const view = views.get(key);
      if (!view) return;
      foldDelta(view.drawn, this.registry, entry.deltas[index]);
      if (!entry.held) foldDelta(view.stored, this.registry, entry.deltas[index]);
    });
    const added = new Set(), removed = new Set();
    for (const [key, view] of views) {
      const present = this.drawn.has(key) || this.stored.has(key);
      const row = this.confirmed[key];
      const envelope = Object.fromEntries(ENVELOPE.filter((name) => row?.[name] !== undefined).map((name) => [name, row[name]]));
      for (const kind of ['drawn', 'stored']) {
        const record = view[kind].get(key);
        if (record) this[kind].set(key, frozen({ ...record, ...envelope }));
        else this[kind].delete(key);
      }
      const record = this.drawn.get(key) ?? this.stored.get(key);
      if (record && !present) { this.order.place(key, record); added.add(key); }
      if (!record && present) removed.add(key);
    }
    this.order.update(added, removed);
  }
}
