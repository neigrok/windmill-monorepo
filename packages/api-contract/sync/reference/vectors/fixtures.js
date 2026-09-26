// Shared inputs for the corpus builders: the probe registry and product, stamp and row shorthands,
// and server states whose digests and counters are computed from their rows.

import { fileURLToPath } from 'node:url';
import { ZERO_DIGEST, replaceRow } from '../core/digest.js';
import { Registry } from '../core/registry.js';
import { compactRow, isAlive } from '../core/rows.js';
import { ProbeProduct } from '../probe/product.js';
import { ServerState } from '../server/state.js';

export const registry = Registry.fromFile(fileURLToPath(new URL('../../probe.registry.json', import.meta.url)));
export const product = new ProbeProduct();

export const ACTOR = 'r_aaaaaaaaaaaa';
export const OTHER = 'r_bbbbbbbbbbbb';

export function st(ms, counter = 0, actor = ACTOR) {
  return `${ms}:${counter}:${actor}`;
}

export function vector(name, input, expect) {
  return { name, input, expect };
}

// A server state from its scopes and typed rows; each scope's digest and card counter follow its rows.
// scopes: {key: {kind, owner, state?, seq?, governedBy?, deadAt?}}.
export function serverState({ epoch = 'ep-1', clock = { ms: 0, counter: 0 }, accounts = { A: { name: 'Ann' }, B: { name: 'Bob' } }, scopes = {}, rows = {}, spent = {}, revisions = {}, productState }) {
  const json = { epoch, clock, accounts, scopes: {}, rows: {}, spent: {}, revisions };
  for (const [key, scope] of Object.entries(scopes)) {
    const own = (rows[key] ?? []).map(compactRow);
    const counters = {};
    for (const type of registry.types.values()) {
      if (type.cap === undefined) continue;
      const alive = own.filter((row) => row.t === type.type && isAlive(row)).length;
      if (alive) counters[type.type] = alive;
    }
    const seq = scope.seq ?? Math.max(0, ...own.map((row) => row.seq), ...(spent[key] ?? []).map((entry) => entry.seq));
    json.scopes[key] = { state: 'alive', ...scope, seq, counters, digest: own.reduce((digest, row) => replaceRow(digest, undefined, row), ZERO_DIGEST) };
    json.rows[key] = own;
    if (spent[key]) json.spent[key] = spent[key];
  }
  if (productState) json.product = productState;
  return new ServerState(json).toJSON();
}

export function productScope(owner = 'A', extra = {}) {
  return { kind: 'product', owner, ...extra };
}

export function treeScope(owner, board, extra = {}) {
  return { kind: 'tree', owner, governedBy: `acct:${owner}/probe#board#${board}`, ...extra };
}

export function overlayScope(owner, board, extra = {}) {
  return { kind: 'overlay', owner, governedBy: `tree:${board}`, ...extra };
}

export function row(fields) {
  return compactRow({ rc: fields.seq * 1000, ru: fields.seq * 1000, ...fields });
}


// A seeded generator (mulberry32) for builders and the replay simulator; nothing in the corpus uses
// Math.random.
export class Rng {
  constructor(seed) {
    this.state = seed >>> 0;
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n) {
    return Math.floor(this.next() * n);
  }

  chance(p) {
    return this.next() < p;
  }

  pick(list) {
    return list[this.int(list.length)];
  }
}
