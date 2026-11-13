// Each lane keeps its projected lattice, server-confirmed baseline and discard epoch in one record.
// A transaction joins matching epochs only; a discarded lane can never be revived by an older writer.
// Where the browser refuses the database the same records live in this document's memory: only offline durability is gone.

import { reportInvalidProgressMark, reportRoadmapFailure } from '../reportFailure.js';
import { TreeLattice } from './lattice.js';
import { ProgressLattice } from './progressLattice.js';
import { frameWrites, pendingGestures, retainedGestures, unconfirmedStamps, writeStamps } from './pendingWrites.js';

const DB_NAME = 'windmill-sync';
const STORE = 'trees';
const LANES = ['structure', 'progress'];
const CHANNEL = 'windmill-roadmap-lane-epochs';

class DatabaseRecords {
  constructor(db) { this.db = db; }

  // One transaction over a tree's record: `work` reads what is stored and may put its replacement. A failure rejects with
  // what failed: `work`'s own throw, else the failing request's error, which reaches the transaction before its own
  // `error` is set.
  transact(treeId, mode, work) {
    return new Promise((resolve, reject) => {
      const txn = this.db.transaction(STORE, mode);
      const store = txn.objectStore(STORE);
      const get = store.get(treeId);
      let answer, failure;
      get.onsuccess = () => {
        try {
          answer = work(get.result, (next) => store.put(next, treeId));
        } catch (error) {
          failure = error;
          txn.abort();
        }
      };
      const failed = (event) => reject(failure ?? event?.target?.error ?? txn.error ?? new DOMException('The record was not written', 'AbortError'));
      txn.oncomplete = () => resolve(answer);
      txn.onerror = failed;
      txn.onabort = failed;
    });
  }

  treeIds() {
    return new Promise((resolve, reject) => {
      const request = this.db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
  }

  clear(treeId) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(treeId);
      const failed = (event) => reject(event?.target?.error ?? transaction.error ?? new DOMException('The record was not cleared', 'AbortError'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = failed;
      transaction.onabort = failed;
    });
  }
}

// What a refused database leaves: one map for the document, so an unsent write outlives its session as a stored one would.
class DocumentRecords {
  constructor() {
    this.records = new Map();
    this.announced = false;
  }

  announce() {
    if (this.announced) return;
    this.announced = true;
    console.warn('[sync] this browser refuses IndexedDB: writes reach the server and nothing stays on this device');
  }

  async transact(treeId, mode, work) {
    return work(this.records.get(treeId), (next) => this.records.set(treeId, structuredClone(next)));
  }

  async treeIds() { return [...this.records.keys()]; }
  async clear(treeId) { this.records.delete(treeId); }
}

const THIS_DOCUMENT = new DocumentRecords();

export class SyncStore {
  constructor({ reportFailure = reportRoadmapFailure } = {}) {
    this.reportInvalidProgressMark = () => reportInvalidProgressMark(reportFailure);
    this.refused = THIS_DOCUMENT;
    this.dbPromise = null;
    this.opened = null;
    this.latest = new Map();
    this.chain = Promise.resolve();
    this.listeners = new Map();
    this.channel = null;
  }

  db() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE); };
      open.onsuccess = () => {
        const forget = () => { this.dbPromise = null; this.opened = null; };
        open.result.onversionchange = () => { open.result.close(); forget(); };
        open.result.onclose = forget;
        this.opened = open.result;
        resolve(open.result);
      };
      open.onerror = () => reject(open.error);
    });
    return this.dbPromise;
  }

  records(durable = false) {
    const records = this.db().then((db) => new DatabaseRecords(db));
    if (durable) return records;
    return records.catch(() => {
      this.refused.announce();
      return this.refused;
    });
  }

  // Whether this browser keeps what is written here past this document.
  holdsOnDevice() {
    return this.db().then(() => true, () => false);
  }

  async requestPersistent() {
    if (!await this.holdsOnDevice()) return false;
    try { return await navigator.storage?.persist?.() ?? false; } catch { return false; }
  }

  async load(treeId) {
    const records = await this.records();
    if (records !== this.refused && this.refused.records.has(treeId)) await this.takeBackFromDocument(treeId);
    const stored = await records.transact(treeId, 'readonly', (row) => row);
    this.latest.set(treeId, normalizeRecord(stored));
    return stored ? normalizeRecord(stored) : null;
  }

  // The database opened after refusing earlier in this document: what the document held moves into it.
  async takeBackFromDocument(treeId) {
    const held = this.refused.records.get(treeId);
    await this.save(treeId, held);
    this.refused.records.delete(treeId);
  }

  async treeIds({ durable = false } = {}) {
    return (await this.records(durable)).treeIds();
  }

  async clear(treeId, { durable = false } = {}) {
    await (await this.records(durable)).clear(treeId);
    this.latest.delete(treeId);
    this.refused.records.delete(treeId);
  }

  save(treeId, value) {
    const snapshot = { ...value, epochs: { ...(value.epochs ?? { structure: 0, progress: 0 }) } };
    const pending = this.chain.then(() => this.saveOnce(treeId, snapshot));
    this.chain = pending.catch(() => {});
    return pending;
  }

  async saveOnce(treeId, value) {
    return (await this.records()).transact(treeId, 'readwrite', (stored, put) => {
      const { merged, staleLanes } = mergedRecord(stored, value, this.reportInvalidProgressMark);
      put(merged);
      this.latest.set(treeId, merged);
      return { status: staleLanes.length ? 'stale' : 'saved', staleLanes, value: merged };
    });
  }

  // Leaving leaves no time for a read or a callback: the record goes down whole, joined from the last one seen, and commit() asks the browser to finish.
  async saveWhileLeaving(treeId, value) {
    if (!this.opened || !this.latest.has(treeId)) return this.save(treeId, value);
    const { merged, staleLanes } = mergedRecord(this.latest.get(treeId), value, this.reportInvalidProgressMark);
    this.latest.set(treeId, merged);
    const txn = this.opened.transaction(STORE, 'readwrite');
    txn.objectStore(STORE).put(merged, treeId);
    txn.commit?.();
    return { status: staleLanes.length ? 'stale' : 'saved', staleLanes, value: merged };
  }

  // Discards what the writer showed, every unconfirmed register unless it names them; another writer's unsent work stays.
  replaceLane(treeId, lane, epoch, discarded = null) {
    const pending = this.chain.then(async () => {
      const records = await this.records();
      const result = await records.transact(treeId, 'readwrite', (stored, put) => {
        const value = normalizeRecord(stored);
        if (value.epochs[lane] !== epoch) return { status: 'stale', value };
        if (value.confirmed[lane] == null) return { status: 'unavailable', value };
        const replaced = withoutDiscarded(value, lane, discarded, this.reportInvalidProgressMark);
        put(replaced);
        this.latest.set(treeId, replaced);
        return { status: 'replaced', value: replaced };
      });
      if (result.status !== 'replaced') return result;
      try {
        this.publishEpoch(treeId, lane, result.value.epochs[lane]);
      } catch (error) {
        result.notificationError = error;
      }
      return result;
    });
    this.chain = pending.catch(() => {});
    return pending;
  }

  // The wire send runs inside the read transaction: a discard cannot commit between its check and send.
  async withEpoch(treeId, lane, epoch, send) {
    return (await this.records()).transact(treeId, 'readonly', (stored) => {
      const value = normalizeRecord(stored);
      this.latest.set(treeId, value);
      if (value.epochs[lane] !== epoch) return { status: 'stale', staleLanes: [lane], value };
      send();
      return { status: 'current' };
    });
  }

  subscribeEpochs(treeId, handler) {
    if (!this.channel && typeof BroadcastChannel === 'function') {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.unref?.();
      this.channel.onmessage = ({ data }) => {
        if (!LANES.includes(data?.lane) || !Number.isSafeInteger(data.epoch)) return;
        for (const listener of this.listeners.get(data.treeId) ?? []) listener(data);
      };
    }
    const handlers = this.listeners.get(treeId) ?? new Set();
    handlers.add(handler);
    this.listeners.set(treeId, handlers);
    return () => {
      handlers.delete(handler);
      if (!handlers.size) this.listeners.delete(treeId);
      if (this.listeners.size) return;
      this.channel?.close();
      this.channel = null;
    };
  }

  publishEpoch(treeId, lane, epoch) {
    const event = { treeId, lane, epoch };
    for (const listener of this.listeners.get(treeId) ?? []) listener(event);
    if (typeof BroadcastChannel !== 'function') return;
    const channel = this.channel ?? new BroadcastChannel(CHANNEL);
    try {
      channel.postMessage(event);
    } finally {
      if (channel !== this.channel) channel.close();
    }
  }
}

function normalizeRecord(value = {}) {
  return {
    frame: value.frame ?? { nodes: [], edges: [], kinds: [] },
    progress: value.progress ?? { marks: [] },
    lastSeq: value.lastSeq ?? 0,
    epochs: { structure: value.epochs?.structure ?? 0, progress: value.epochs?.progress ?? 0 },
    confirmed: { structure: value.confirmed?.structure ?? null, progress: value.confirmed?.progress ?? null },
    ...(value.gestures ? { gestures: structuredClone(value.gestures) } : {}),
  };
}

function laneField(lane) {
  return lane === 'structure' ? 'frame' : 'progress';
}

// Unreadable structure frames yield to the writer; invalid progress rows report and leave valid rows intact.
function joinLane(lane, left, right, onInvalidMark) {
  const blank = () => (lane === 'structure' ? new TreeLattice() : new ProgressLattice());
  let lattice = blank();
  try {
    if (left) lattice.join(left, onInvalidMark);
  } catch {
    lattice = blank();
  }
  if (right) lattice.join(right, onInvalidMark);
  return lattice.toFrame();
}

// What a writer's value makes of a stored record; only a lane at its stored epoch joins.
function mergedRecord(record, value, onInvalidMark) {
  const stored = normalizeRecord(record);
  const merged = normalizeRecord(stored);
  const staleLanes = [];
  for (const lane of LANES) {
    const field = laneField(lane);
    if (value[field] === undefined) continue;
    if ((value.epochs?.[lane] ?? 0) !== stored.epochs[lane]) {
      staleLanes.push(lane);
      continue;
    }
    merged[field] = joinLane(lane, stored[field], value[field], onInvalidMark);
    const confirmed = value.confirmed?.[lane];
    if (confirmed != null) merged.confirmed[lane] = joinLane(lane, stored.confirmed[lane], confirmed, onInvalidMark);
    if (value.gestures?.[lane] || (lane === 'progress' && stored.gestures?.progress)) {
      merged.gestures ??= { structure: {}, progress: {} };
      const gestures = { ...stored.gestures?.[lane], ...value.gestures?.[lane] };
      merged.gestures[lane] = pendingGestures({}, merged.confirmed[lane], retainedGestures(lane, merged[field], gestures));
    }
    if (lane === 'structure') merged.lastSeq = Math.max(stored.lastSeq, value.lastSeq ?? 0);
  }
  return { merged, staleLanes };
}

// The lane at its confirmed baseline, with only the discarded registers gone from what stood above it.
function withoutDiscarded(value, lane, discarded, onInvalidMark) {
  const field = laneField(lane);
  const confirmed = value.confirmed[lane];
  const unconfirmed = unconfirmedStamps(writeStamps(value[field]), writeStamps(confirmed));
  const gone = discarded ?? unconfirmed;
  const standing = frameWrites(value[field], (key, stamp) => unconfirmed[key] === stamp && gone[key] !== stamp);
  const replaced = { ...value, epochs: { ...value.epochs, [lane]: value.epochs[lane] + 1 } };
  replaced[field] = joinLane(lane, confirmed, standing, onInvalidMark);
  if (lane === 'structure') replaced.lastSeq = 0;
  if (value.gestures) replaced.gestures = { ...value.gestures, [lane]: pendingGestures(replaced[field], confirmed) };
  return replaced;
}
