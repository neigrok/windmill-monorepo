// §7.6 views: confirmed rows joined with pending deltas and predictions in commit order; `drawn` has
// held entries, `stored` does not. Texts are plain strings; serials come only from confirmed rows.
// `except` leaves out entries a commit is retiring (§7.1 step 4).

import { joinRecord } from '../core/merge.js';
import { isVisible, latticeOf, recordKey } from '../core/rows.js';

const PENDING = new Set(['ready', 'sent', 'acked']);

export function pendingEntries(replica, scope, withHeld, except = []) {
  return replica.entries(scope).filter((entry) => (PENDING.has(entry.state) || (withHeld && entry.state === 'held')) && !except.includes(entry));
}

function viewRecord(row) {
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
  if (current.v) next.v = current.v;
  records.set(key, next);
}

export function view(replica, registry, scope, { withHeld, except }) {
  const records = new Map();
  for (const row of replica.confirmedRows(scope)) records.set(recordKey(row.t, row.id), viewRecord(row));
  for (const entry of pendingEntries(replica, scope, withHeld, except)) {
    for (const delta of [...(entry.intent.d ?? []), ...(entry.predict ?? [])]) foldDelta(records, registry, delta);
  }
  return records;
}

export function visibleCount(registry, records, t) {
  let count = 0;
  for (const record of records.values()) if (record.t === t && isVisible(registry.type(t), record)) count += 1;
  return count;
}

export function drawn(replica, registry, scope, except = []) {
  return view(replica, registry, scope, { withHeld: true, except });
}

export function stored(replica, registry, scope) {
  return view(replica, registry, scope, { withHeld: false });
}

export function capCount(replica, registry, scope, t) {
  return visibleCount(registry, stored(replica, registry, scope), t);
}
