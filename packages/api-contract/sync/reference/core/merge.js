// §3.2 lattice joins over `[value, stamp]` registers, lives and borns; `undefined` is the absent
// register. Each join is the maximum of a total order (§3.3).

import { compareJcs } from './jcs.js';
import { Stamp } from './stamp.js';

export function joinLww(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const byStamp = Stamp.compare(a[1], b[1]);
  if (byStamp !== 0) return byStamp > 0 ? a : b;
  return compareJcs(a[0], b[0]) >= 0 ? a : b;
}

export function joinRanked(a, b, rank) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const rankA = rankOf(rank, a[0]);
  const rankB = rankOf(rank, b[0]);
  if (rankA !== rankB) return rankA > rankB ? a : b;
  return joinLww(a, b);
}

export function joinFww(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const byStamp = Stamp.compare(a[1], b[1]);
  if (byStamp !== 0) return byStamp < 0 ? a : b;
  return compareJcs(a[0], b[0]) <= 0 ? a : b;
}

export function joinLife(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const byStamp = Stamp.compare(a[1], b[1]);
  if (byStamp !== 0) return byStamp > 0 ? a : b;
  return a[0] === 'alive' ? a : b;
}

export function joinBorn(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Stamp.compare(a, b) <= 0 ? a : b;
}

function rankOf(rank, value) {
  if (typeof value !== 'string' || !Object.hasOwn(rank, value)) throw new Error(`value ${JSON.stringify(value)} has no rank`);
  return rank[value];
}

export function joinRegister(field, a, b) {
  if (field === undefined) {
    if (a !== undefined && b !== undefined) throw new Error('two registers of an unknown field meet in a join');
    return a ?? b;
  }
  switch (field.kind) {
    case 'lww':
      return joinLww(a, b);
    case 'ranked':
      return joinRanked(a, b, field.rank);
    case 'fww':
    case 'const':
    case 'time':
      return joinFww(a, b);
    default:
      throw new Error(`${field.kind} fields are not joined`);
  }
}

// §3.2 joinRecord over the lattice part of two records `{life?, born?, f?}` of one type. `type` may be
// undefined for a type the registry does not know; its rows are never joined with a pending write.
export function joinRecord(type, A, B) {
  const out = {};
  const life = joinLife(A.life, B.life);
  const born = joinBorn(A.born, B.born);
  if (life !== undefined) out.life = life;
  if (born !== undefined) out.born = born;
  const names = new Set([...Object.keys(A.f ?? {}), ...Object.keys(B.f ?? {})]);
  if (names.size) {
    out.f = {};
    for (const name of [...names].sort()) out.f[name] = joinRegister(type?.field(name), A.f?.[name], B.f?.[name]);
  }
  return out;
}
