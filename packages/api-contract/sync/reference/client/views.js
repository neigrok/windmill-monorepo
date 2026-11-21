// §7.6 views: confirmed rows joined with pending deltas and predictions in commit order; `drawn` has
// held entries, `stored` does not. Texts are plain strings; command predictions may overlay serials.
// `except` leaves out the deltas a commit retires or folds with a retire (§7.1 step 4).

import { joinRecord } from '../core/merge.js';
import { isVisible, latticeOf, recordKey } from '../core/rows.js';
import { effectsOf } from './projections.js';

const PENDING = new Set(['ready', 'sent', 'acked']);
const NOTHING = new Set();

function pendingEntries(replica, withHeld) {
  return replica.entries().filter((entry) => PENDING.has(entry.state) || (withHeld && entry.state === 'held'));
}

// Whether an entry draws in `scope`: an active effect there, told without building its effects.
function reaches(entry, scope) {
  return entry.predictions ? entry.predictions.some((projection) => !projection.covered && projection.scope === scope) : entry.scope === scope;
}

// A confirmed row as a view record: texts as plain strings, serials copied.
export function viewRecord(row) {
  const record = { t: row.t, id: row.id, ...latticeOf(row) };
  if (row.x) record.x = Object.fromEntries(Object.entries(row.x).map(([name, text]) => [name, text.text]));
  if (row.v) record.v = { ...row.v };
  return record;
}

// One delta folded into a view's records: the lattice join, and its text replacing the view's.
export function foldDelta(records, registry, delta) {
  const key = recordKey(delta.t, delta.id);
  const current = records.get(key) ?? { t: delta.t, id: delta.id };
  const next = { t: delta.t, id: delta.id, ...joinRecord(registry.type(delta.t), latticeOf(current), latticeOf(delta)) };
  if (current.x || delta.x) {
    next.x = { ...(current.x ?? {}) };
    for (const [name, write] of Object.entries(delta.x ?? {})) next.x[name] = write.text;
  }
  if (current.v || delta.v) next.v = { ...(current.v ?? {}), ...(delta.v ?? {}) };
  records.set(key, next);
}

export function view(replica, registry, scope, { withHeld, except = NOTHING }) {
  const records = new Map();
  for (const row of replica.confirmedRows(scope)) records.set(recordKey(row.t, row.id), viewRecord(row));
  for (const entry of pendingEntries(replica, withHeld)) {
    if (!reaches(entry, scope)) continue;
    for (const effect of effectsOf(entry, { active: true })) {
      if (effect.scope !== scope) continue;
      for (const delta of effect.d) if (!except.has(delta)) foldDelta(records, registry, delta);
    }
  }
  return records;
}

// One scope's drawn or stored records as `view` folds them, each record folded when first asked for: a commit
// reads the records its changes name, and folds the whole view only to iterate it. It reads the replica when
// asked, so a commit reads it before writing.
export class RecordView {
  constructor(replica, registry, scope, { withHeld, except = NOTHING }) {
    Object.assign(this, { replica, registry, scope, withHeld, except });
    this.folded = new Map();
  }

  get(key) {
    if (this.whole) return this.whole.get(key);
    if (!this.folded.has(key)) this.folded.set(key, this.fold(key));
    return this.folded.get(key);
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  entries() {
    return (this.whole ??= view(this.replica, this.registry, this.scope, this)).entries();
  }

  values() {
    return (this.whole ??= view(this.replica, this.registry, this.scope, this)).values();
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  fold(key) {
    const [t, id] = JSON.parse(key);
    const names = (delta) => delta.t === t && (typeof id === 'string' ? delta.id === id : typeof delta.id !== 'string' && recordKey(delta.t, delta.id) === key);
    this.deltas ??= pendingEntries(this.replica, this.withHeld).filter((entry) => reaches(entry, this.scope))
      .flatMap((entry) => effectsOf(entry, { active: true }).filter((effect) => effect.scope === this.scope).flatMap(({ d }) => d));
    const row = this.replica.confirmed[this.scope]?.[key];
    const records = new Map(row ? [[key, viewRecord(row)]] : []);
    for (const delta of this.deltas) if (names(delta) && !this.except.has(delta)) foldDelta(records, this.registry, delta);
    return records.get(key);
  }
}

export function visibleCount(registry, records, t) {
  let count = 0;
  for (const record of records.values()) if (record.t === t && isVisible(registry.type(t), record)) count += 1;
  return count;
}

export function drawn(replica, registry, scope, except = NOTHING) {
  return view(replica, registry, scope, { withHeld: true, except });
}

export function stored(replica, registry, scope, except = NOTHING) {
  return view(replica, registry, scope, { withHeld: false, except });
}

export function capCount(replica, registry, scope, t) {
  return visibleCount(registry, stored(replica, registry, scope), t);
}
