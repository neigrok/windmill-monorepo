// §9.1 rows and deltas. A record is addressed by `(t, id)`; an id is a string or, for a tuple-keyed
// type, an array whose JCS is its identity. Rows never carry empty `f`, `x` or `v` maps.

import { compareJcs, jcs } from './jcs.js';

export function recordKey(t, id) {
  return jcs([t, id]);
}

export function isAlive(record) {
  return record.life === undefined || record.life[0] === 'alive';
}

// §7.6 visible(r): a singleton always; a record of a type with life while its life is alive (a view
// record without a life register is not); otherwise while a visibleWhen field (or, without visibleWhen,
// any field) holds a value other than null or "". A type the registry does not know is never visible.
// A text value may be a row's {text, rev, merged} or a view's plain string.
export function isVisible(type, record) {
  if (type === undefined) return false;
  if (type.identity === 'singleton') return true;
  if (type.life) return record.life?.[0] === 'alive';
  const valueOf = (name) => {
    const text = record.x?.[name];
    if (text !== undefined) return typeof text === 'string' ? text : text.text;
    return record.f?.[name]?.[0];
  };
  if (!type.visibleWhen) return Object.keys(record.f ?? {}).length + Object.keys(record.x ?? {}).length > 0;
  return type.visibleWhen.some((name) => {
    const value = valueOf(name);
    return value !== undefined && value !== null && value !== '';
  });
}

// Every stamp a row or delta carries: its life's, its born, and each lattice register's.
export function stampsOf(record) {
  const stamps = [];
  if (record.life) stamps.push(record.life[1]);
  if (record.born !== undefined) stamps.push(record.born);
  for (const register of Object.values(record.f ?? {})) stamps.push(register[1]);
  return stamps;
}

export function latticeOf(record) {
  const out = {};
  if (record.life !== undefined) out.life = record.life;
  if (record.born !== undefined) out.born = record.born;
  if (record.f && Object.keys(record.f).length) out.f = record.f;
  return out;
}

export function compactRow(row) {
  const out = { t: row.t, id: row.id };
  if (row.life !== undefined) out.life = row.life;
  if (row.born !== undefined) out.born = row.born;
  for (const part of ['f', 'x', 'v']) {
    if (row[part] && Object.keys(row[part]).length) out[part] = sortedMap(row[part]);
  }
  for (const part of ['seq', 'rc', 'ru']) if (row[part] !== undefined) out[part] = row[part];
  return out;
}

export function thinRow(row) {
  const out = { t: row.t, id: row.id, life: row.life };
  if (row.born !== undefined) out.born = row.born;
  out.seq = row.seq;
  return out;
}

export function sortedMap(map) {
  const out = {};
  for (const key of Object.keys(map).sort()) out[key] = map[key];
  return out;
}

// Records order by type, then by the UTF-8 bytes of the id's JCS encoding.
export function compareRecords(a, b) {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  return compareJcs(a.id, b.id);
}

// §6.7 keyset order: (seq, type, id).
export function compareFeed(a, b) {
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return compareRecords(a, b);
}
