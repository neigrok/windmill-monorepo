// Each lane keeps its projected lattice, server-confirmed baseline and discard epoch in one record.
// A transaction joins matching epochs only; a discarded lane can never be revived by an older writer.

import { TreeLattice } from './lattice.js';
import { ProgressLattice } from './progressLattice.js';

const DB_NAME = 'windmill-sync';
const STORE = 'trees';
const LANES = ['structure', 'progress'];
const CHANNEL = 'windmill-roadmap-lane-epochs';

export class SyncStore {
  constructor() {
    this.dbPromise = null;
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
        open.result.onversionchange = () => { open.result.close(); this.dbPromise = null; this.atRisk = true; };
        resolve(open.result);
      };
      open.onerror = () => reject(open.error);
    });
    return this.dbPromise;
  }

  async requestPersistent() {
    try { return await navigator.storage?.persist?.() ?? false; } catch { return false; }
  }

  async load(treeId) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(treeId);
      request.onsuccess = () => {
        const value = request.result ? normalizeRecord(request.result) : null;
        resolve(value);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async treeIds() {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
  }

  async clear(treeId) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(treeId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  save(treeId, value) {
    const snapshot = { ...value, epochs: { ...(value.epochs ?? { structure: 0, progress: 0 }) } };
    const pending = this.chain.then(() => this.saveOnce(treeId, snapshot));
    this.chain = pending.catch(() => {});
    return pending;
  }

  async saveOnce(treeId, value) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const txn = db.transaction(STORE, 'readwrite');
      const store = txn.objectStore(STORE);
      const get = store.get(treeId);
      let result, failure;
      get.onsuccess = () => {
        try {
          const stored = normalizeRecord(get.result);
          const merged = normalizeRecord(stored);
          const staleLanes = [];
          for (const lane of LANES) {
            const field = lane === 'structure' ? 'frame' : 'progress';
            if (value[field] === undefined) continue;
            if ((value.epochs?.[lane] ?? 0) !== stored.epochs[lane]) {
              staleLanes.push(lane);
              continue;
            }
            merged[field] = joinLane(lane, stored[field], value[field]);
            const confirmed = value.confirmed?.[lane];
            if (confirmed != null) merged.confirmed[lane] = joinLane(lane, stored.confirmed[lane], confirmed);
            if (lane === 'structure') merged.lastSeq = Math.max(stored.lastSeq, value.lastSeq ?? 0);
          }
          store.put(merged, treeId);
          result = { status: staleLanes.length ? 'stale' : 'saved', staleLanes, value: merged };
        } catch (error) {
          failure = error;
          txn.abort();
        }
      };
      txn.oncomplete = () => resolve(result);
      txn.onerror = () => reject(failure ?? txn.error);
      txn.onabort = () => reject(failure ?? txn.error);
    });
  }

  replaceLane(treeId, lane, epoch) {
    const pending = this.chain.then(async () => {
      const db = await this.db();
      return new Promise((resolve, reject) => {
        const txn = db.transaction(STORE, 'readwrite');
        const store = txn.objectStore(STORE);
        const get = store.get(treeId);
        let result;
        get.onsuccess = () => {
          const value = normalizeRecord(get.result);
          if (value.epochs[lane] !== epoch) {
            result = { status: 'stale', value };
            return;
          }
          if (value.confirmed[lane] == null) {
            result = { status: 'unavailable', value };
            return;
          }
          const field = lane === 'structure' ? 'frame' : 'progress';
          value[field] = value.confirmed[lane];
          value.epochs[lane] += 1;
          if (lane === 'structure') value.lastSeq = 0;
          store.put(value, treeId);
          result = { status: 'replaced', value };
        };
        txn.oncomplete = () => {
          if (result.status === 'replaced') {
            try { this.publishEpoch(treeId, lane, result.value.epochs[lane]); }
            catch (error) { result.notificationError = error; }
          }
          resolve(result);
        };
        txn.onerror = () => reject(txn.error);
        txn.onabort = () => reject(txn.error);
      });
    });
    this.chain = pending.catch(() => {});
    return pending;
  }

  // The wire send runs inside the read transaction: a discard cannot commit between its check and send.
  async withEpoch(treeId, lane, epoch, send) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const txn = db.transaction(STORE, 'readonly');
      const get = txn.objectStore(STORE).get(treeId);
      let result, failure;
      get.onsuccess = () => {
        try {
          const value = normalizeRecord(get.result);
          if (value.epochs[lane] !== epoch) {
            result = { status: 'stale', staleLanes: [lane], value };
            return;
          }
          send();
          result = { status: 'current' };
        } catch (error) {
          failure = error;
          txn.abort();
        }
      };
      txn.oncomplete = () => resolve(result);
      txn.onerror = () => reject(failure ?? txn.error);
      txn.onabort = () => reject(failure ?? txn.error);
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
    try { channel.postMessage(event); }
    finally { if (channel !== this.channel) channel.close(); }
  }
}

function normalizeRecord(value = {}) {
  return {
    frame: value.frame ?? { nodes: [], edges: [], kinds: [] },
    progress: value.progress ?? { marks: [] },
    lastSeq: value.lastSeq ?? 0,
    epochs: { structure: value.epochs?.structure ?? 0, progress: value.epochs?.progress ?? 0 },
    confirmed: { structure: value.confirmed?.structure ?? null, progress: value.confirmed?.progress ?? null },
  };
}

function joinLane(lane, left, right) {
  const lattice = lane === 'structure' ? new TreeLattice() : new ProgressLattice();
  if (left) lattice.join(left);
  if (right) lattice.join(right);
  return lattice.toFrame();
}
