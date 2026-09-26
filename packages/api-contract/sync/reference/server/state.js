// §2.1 the server's platform tables and the typed rows behind them, as one in-memory value. `toJSON`
// gives the canonical form the corpus carries: maps sorted, rows sorted by (t, id), empty parts left out.

import { ZERO_DIGEST } from '../core/digest.js';
import { compactRow, compareRecords, isAlive, recordKey, sortedMap } from '../core/rows.js';

function scopeJson(scope) {
  const out = { kind: scope.kind, owner: scope.owner, state: scope.state, seq: scope.seq, counters: sortedMap(scope.counters), digest: scope.digest };
  if (scope.governedBy !== undefined) out.governedBy = scope.governedBy;
  if (scope.deadAt !== undefined) out.deadAt = scope.deadAt;
  return out;
}

function spentJson(entry) {
  const out = { t: entry.t, id: entry.id };
  if (entry.born !== undefined) out.born = entry.born;
  return { ...out, lifeStamp: entry.lifeStamp, seq: entry.seq };
}

function sortedEntries(map) {
  return Object.keys(map).sort().map((key) => [key, map[key]]);
}

export class ServerState {
  constructor(json) {
    this.epoch = json.epoch;
    this.clock = { ...json.clock };
    this.accounts = structuredClone(json.accounts ?? {});
    this.scopes = structuredClone(json.scopes ?? {});
    this.rows = {};
    for (const [scope, rows] of Object.entries(json.rows ?? {})) {
      this.rows[scope] = Object.fromEntries(rows.map((row) => [recordKey(row.t, row.id), compactRow(row)]));
    }
    this.spent = {};
    for (const [scope, spent] of Object.entries(json.spent ?? {})) {
      this.spent[scope] = Object.fromEntries(spent.map((entry) => [recordKey(entry.t, entry.id), { ...entry }]));
    }
    this.revisions = {};
    for (const [scope, revisions] of Object.entries(json.revisions ?? {})) {
      this.revisions[scope] = revisions.map((revision) => ({ ...revision }));
    }
    this.replicas = structuredClone(json.replicas ?? {});
    this.results = {};
    for (const [replica, results] of Object.entries(json.results ?? {})) {
      this.results[replica] = Object.fromEntries(results.map((result) => [String(result.n), structuredClone(result)]));
    }
    this.requests = {};
    for (const [account, requests] of Object.entries(json.requests ?? {})) {
      this.requests[account] = Object.fromEntries(requests.map((request) => [request.requestId, structuredClone(request)]));
    }
    this.product = structuredClone(json.product ?? {});
  }

  static empty({ epoch, accounts = {}, clock = { ms: 0, counter: 0 } }) {
    return new ServerState({ epoch, clock, accounts });
  }

  clone() {
    return new ServerState(this.toJSON());
  }

  toJSON() {
    const out = { epoch: this.epoch, clock: { ...this.clock } };
    if (Object.keys(this.accounts).length) out.accounts = Object.fromEntries(sortedEntries(this.accounts));
    if (Object.keys(this.scopes).length) out.scopes = Object.fromEntries(sortedEntries(this.scopes).map(([key, scope]) => [key, scopeJson(scope)]));
    const rows = sortedEntries(this.rows)
      .map(([scope, map]) => [scope, Object.values(map).sort(compareRecords)])
      .filter(([, list]) => list.length);
    if (rows.length) out.rows = Object.fromEntries(rows);
    const spent = sortedEntries(this.spent)
      .map(([scope, map]) => [scope, Object.values(map).sort(compareRecords).map(spentJson)])
      .filter(([, list]) => list.length);
    if (spent.length) out.spent = Object.fromEntries(spent);
    const revisions = sortedEntries(this.revisions)
      .map(([scope, list]) => [scope, [...list].sort((a, b) => compareRecords(a, b) || (a.field < b.field ? -1 : a.field > b.field ? 1 : a.rev - b.rev))])
      .filter(([, list]) => list.length);
    if (revisions.length) out.revisions = Object.fromEntries(revisions);
    if (Object.keys(this.replicas).length) out.replicas = Object.fromEntries(sortedEntries(this.replicas));
    const results = sortedEntries(this.results)
      .map(([replica, map]) => [replica, Object.values(map).sort((a, b) => a.n - b.n)])
      .filter(([, list]) => list.length);
    if (results.length) out.results = Object.fromEntries(results);
    const requests = sortedEntries(this.requests)
      .map(([account, map]) => [account, Object.values(map).sort((a, b) => (a.requestId < b.requestId ? -1 : 1))])
      .filter(([, list]) => list.length);
    if (requests.length) out.requests = Object.fromEntries(requests);
    if (Object.keys(this.product).length) out.product = structuredClone(this.product);
    return out;
  }

  scope(key) {
    return this.scopes[key];
  }

  insertScope(key, fields) {
    this.scopes[key] = { counters: {}, digest: ZERO_DIGEST, seq: 0, state: 'alive', ...fields };
    return this.scopes[key];
  }

  row(scope, t, id) {
    return this.rows[scope]?.[recordKey(t, id)];
  }

  rowsOf(scope) {
    return Object.values(this.rows[scope] ?? {});
  }

  putRow(scope, row) {
    this.rows[scope] ??= {};
    this.rows[scope][recordKey(row.t, row.id)] = compactRow(row);
  }

  deleteRow(scope, t, id) {
    delete this.rows[scope]?.[recordKey(t, id)];
  }

  spentEntry(scope, t, id) {
    return this.spent[scope]?.[recordKey(t, id)];
  }

  spentOf(scope) {
    return Object.values(this.spent[scope] ?? {});
  }

  putSpent(scope, entry) {
    this.spent[scope] ??= {};
    this.spent[scope][recordKey(entry.t, entry.id)] = entry;
  }

  deleteSpent(scope, t, id) {
    delete this.spent[scope]?.[recordKey(t, id)];
  }

  // The record as the merge sees it: a typed row, or a spent id's life and born.
  stored(scope, t, id) {
    const row = this.row(scope, t, id);
    if (row) return row;
    const spent = this.spentEntry(scope, t, id);
    if (!spent) return undefined;
    const record = { t, id, life: ['dead', spent.lifeStamp], seq: spent.seq };
    if (spent.born !== undefined) record.born = spent.born;
    return record;
  }

  // §4.2 the id state `lock` reports.
  idState(registry, scope, type, id) {
    const here = this.stored(scope, type.type, id);
    if (here) return { state: isAlive(here) ? 'alive' : 'dead', born: here.born };
    if (type.idSpace === 'global') {
      for (const other of Object.keys(this.scopes)) {
        if (other !== scope && this.stored(other, type.type, id)) return { state: 'foreign' };
      }
    }
    if (type.governs === 'tree') {
      const governed = this.scope(`tree:${id}`);
      if (governed && governed.governedBy !== `${scope}#${type.type}#${id}`) return { state: 'foreign' };
    }
    return { state: 'none' };
  }

  resultOf(replica, n) {
    return this.results[replica]?.[String(n)];
  }

  putResult(replica, row) {
    this.results[replica] ??= {};
    this.results[replica][String(row.n)] = row;
  }

  pruneResults(replica, ackThrough) {
    for (const n of Object.keys(this.results[replica] ?? {})) if (Number(n) <= ackThrough) delete this.results[replica][n];
  }

  revisionsOf(scope, t, id, field) {
    return (this.revisions[scope] ?? []).filter((r) => recordKey(r.t, r.id) === recordKey(t, id) && r.field === field);
  }

  keepRevision(scope, revision, keep) {
    this.revisions[scope] ??= [];
    this.revisions[scope].push(revision);
    const same = this.revisionsOf(scope, revision.t, revision.id, revision.field).sort((a, b) => a.rev - b.rev);
    const drop = new Set(same.slice(0, Math.max(0, same.length - keep)));
    this.revisions[scope] = this.revisions[scope].filter((r) => !drop.has(r));
  }
}
