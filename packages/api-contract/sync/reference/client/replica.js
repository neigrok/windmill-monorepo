// §2.5 the client's local store for one replica, and D-3 the device holding replicas. Scopes are keyed
// by wire reference; `toJSON` is the corpus's canonical form.

import { Offset, observedPair } from '../core/clock.js';
import { CONSTANTS } from '../core/constants.js';
import { ZERO_DIGEST } from '../core/digest.js';
import { Stamp } from '../core/stamp.js';
import { compactRow, compareRecords, recordKey, sortedMap } from '../core/rows.js';

function sortedKeys(map) {
  return Object.keys(map).sort();
}

function rowsJson(byScope) {
  const out = {};
  for (const scope of sortedKeys(byScope)) {
    const rows = Object.values(byScope[scope]).sort(compareRecords);
    if (rows.length) out[scope] = rows;
  }
  return out;
}

function rowsFrom(json) {
  const out = {};
  for (const [scope, rows] of Object.entries(json ?? {})) out[scope] = Object.fromEntries(rows.map((row) => [recordKey(row.t, row.id), row]));
  return out;
}

export function freshMeta(replica, state, account) {
  const meta = {
    replica,
    state,
    nextN: 1,
    hlc: { ms: 0, counter: 0 },
    hlcHigh: Stamp.UNSET,
    admittedHigh: Stamp.UNSET,
    serverOffsetMs: 0,
    offsetSamples: [],
    serverEpoch: null,
    ackThrough: 0,
    authPaused: false,
  };
  if (account !== undefined) meta.account = account;
  return meta;
}

export class Replica {
  constructor(json) {
    this.meta = structuredClone(json.meta);
    this.confirmed = rowsFrom(json.confirmed);
    this.spentIds = rowsFrom(json.spentIds);
    this.cursors = structuredClone(json.cursors ?? {});
    this.staging = {};
    for (const [scope, staged] of Object.entries(json.staging ?? {})) {
      this.staging[scope] = { digest: staged.digest, rows: Object.fromEntries(staged.rows.map((row) => [recordKey(row.t, row.id), row])) };
    }
    this.known = structuredClone(json.known ?? {});
    this.outbox = structuredClone(json.outbox ?? []);
    this.notices = structuredClone(json.notices ?? []);
    this.device = structuredClone(json.device ?? {});
  }

  static fresh({ replica, state = 'anon', account }) {
    return new Replica({ meta: freshMeta(replica, state, account) });
  }

  clone() {
    return new Replica(this.toJSON());
  }

  toJSON() {
    const out = { meta: structuredClone(this.meta) };
    const confirmed = rowsJson(this.confirmed);
    if (Object.keys(confirmed).length) out.confirmed = confirmed;
    const spentIds = rowsJson(this.spentIds);
    if (Object.keys(spentIds).length) out.spentIds = spentIds;
    if (Object.keys(this.cursors).length) out.cursors = Object.fromEntries(sortedKeys(this.cursors).map((scope) => [scope, { ...this.cursors[scope] }]));
    const staging = {};
    for (const scope of sortedKeys(this.staging)) {
      staging[scope] = { digest: this.staging[scope].digest, rows: Object.values(this.staging[scope].rows).sort(compareRecords) };
    }
    if (Object.keys(staging).length) out.staging = staging;
    if (Object.keys(this.known).length) out.known = sortedMap(this.known);
    if (this.outbox.length) out.outbox = this.entries().map((entry) => structuredClone(entry));
    if (this.notices.length) out.notices = structuredClone(this.notices);
    const device = {};
    for (const product of sortedKeys(this.device)) if (Object.keys(this.device[product]).length) device[product] = sortedMap(this.device[product]);
    if (Object.keys(device).length) out.device = device;
    return out;
  }

  get id() {
    return this.meta.replica;
  }

  // §10.2 observe() over stamps the replica receives: the clock and hlcHigh rise to the greatest (§2.5).
  observe(stamps) {
    this.meta.hlc = observedPair(this.meta.hlc, stamps);
    for (const stamp of stamps) this.meta.hlcHigh = Stamp.max(this.meta.hlcHigh, stamp);
  }

  // §10.4: a response's offset sample from the device clocks' readings {send, recv} around the request.
  // A request that straddles a clock jump yields none, and the offset is kept.
  takeOffsetSample(serverTime, { send, recv }, limits = CONSTANTS) {
    const taken = Offset.take({ samples: this.meta.offsetSamples, clockReading: this.meta.clockReading }, { serverTime, send, recv }, limits);
    if (taken === null) return;
    this.meta.offsetSamples = taken.samples;
    this.meta.clockReading = taken.clockReading;
    this.meta.serverOffsetMs = Offset.choose(taken.samples);
  }

  // §9.1: an answer or frame is this replica's only when served as its account. A replica with none
  // (anon) is never answered as another.
  servedAsOther(as) {
    return this.meta.account !== undefined && as !== this.meta.account;
  }

  // §9.6: a 401, a 409 account-mismatch, or a 200 or 409 (the answers whose handling depends on the
  // principal) served as anyone but this replica's account, pauses sync with nothing applied.
  isUnauthenticated({ status, body }) {
    if (status === 401 || (status === 409 && body?.error === 'account-mismatch')) return true;
    return (status === 200 || status === 409) && this.servedAsOther(body?.as);
  }

  // §2.5 admittedHigh: the greatest stamp in any row the server sent or in an acked entry.
  raiseAdmittedHigh(stamps) {
    for (const stamp of stamps) this.meta.admittedHigh = Stamp.max(this.meta.admittedHigh, stamp);
  }

  lineage() {
    return this.meta.state === 'bound' || this.meta.state === 'dormant' ? this.meta.account : 'anon';
  }

  confirmedRow(scope, t, id) {
    return this.confirmed[scope]?.[recordKey(t, id)];
  }

  confirmedRows(scope) {
    return Object.values(this.confirmed[scope] ?? {});
  }

  putConfirmed(scope, row) {
    this.confirmed[scope] ??= {};
    this.confirmed[scope][recordKey(row.t, row.id)] = compactRow(row);
  }

  deleteConfirmed(scope, t, id) {
    delete this.confirmed[scope]?.[recordKey(t, id)];
  }

  spentBorn(scope, t, id) {
    return this.spentIds[scope]?.[recordKey(t, id)]?.born;
  }

  addSpent(scope, t, id, born) {
    this.spentIds[scope] ??= {};
    this.spentIds[scope][recordKey(t, id)] = { t, id, born };
  }

  cursorOf(scope) {
    return this.cursors[scope] ?? { cursor: null, digest: ZERO_DIGEST, booted: false };
  }

  forgetScope(scope) {
    delete this.confirmed[scope];
    delete this.spentIds[scope];
    delete this.cursors[scope];
    delete this.staging[scope];
  }

  // The outbox in commit order.
  entries(scope) {
    const all = [...this.outbox].sort((a, b) => a.commitOrder - b.commitOrder);
    return scope === undefined ? all : all.filter((entry) => entry.scope === scope);
  }

  entry(localId) {
    return this.outbox.find((entry) => entry.localId === localId);
  }

  nextCommitOrder() {
    return 1 + Math.max(0, ...this.outbox.map((entry) => entry.commitOrder));
  }

  removeEntry(localId) {
    this.outbox = this.outbox.filter((entry) => entry.localId !== localId);
  }

  // A gesture id an outbox entry or a notice (`notice:<gestureId>/<k>`) of this replica carries.
  carriesGesture(gestureId) {
    return this.outbox.some((entry) => entry.gestureId === gestureId)
      || this.notices.some((notice) => notice.id.slice('notice:'.length, notice.id.lastIndexOf('/')) === gestureId);
  }

  deviceRows(product) {
    this.device[product] ??= {};
    return this.device[product];
  }
}

// D-3 one device's database: any number of replicas, one of them active, and §2.5 DeviceMeta
// ({forkGuard?, pendingSignIn?}). The active replica is held by reference: re-identify changes its id.
export class Device {
  constructor(json) {
    this.meta = structuredClone(json.meta ?? {});
    this.replicas = json.replicas.map((replica) => new Replica(replica));
    this.activeReplica = this.replica(json.active);
  }

  toJSON() {
    const out = {};
    if (Object.keys(this.meta).length) out.meta = sortedMap(structuredClone(this.meta));
    out.active = this.activeReplica?.id ?? null;
    out.replicas = [...this.replicas].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((replica) => replica.toJSON());
    return out;
  }

  replica(id) {
    return this.replicas.find((replica) => replica.id === id);
  }

  anonReplica() {
    return this.replicas.find((replica) => replica.meta.state === 'anon');
  }

  dormantOf(account) {
    return this.replicas.find((replica) => replica.meta.state === 'dormant' && replica.meta.account === account);
  }

  add(replica) {
    this.replicas.push(replica);
    return replica;
  }

  remove(replica) {
    this.replicas = this.replicas.filter((other) => other !== replica);
  }

  // Gesture ids are unique on the device (§2.5), across every replica.
  carriesGesture(gestureId) {
    return this.replicas.some((replica) => replica.carriesGesture(gestureId));
  }
}
