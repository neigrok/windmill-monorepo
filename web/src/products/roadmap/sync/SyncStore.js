// Durable local store for one tree's lattice: one IndexedDB record per tree holding
// { frame, progress, lastSeq }, written together so a crash never tears them. The coverage vector
// is not persisted; it is rebuilt from the next server graft.
// `save` is a read-join-put inside a single transaction: the join must run synchronously inside
// get.onsuccess and issue the put before yielding, never `await get()` then `await put()`.

import { TreeLattice } from './lattice.js';
import { ProgressLattice } from './progressLattice.js';

const DB_NAME = 'windmill-sync';
const STORE = 'trees';

export class SyncStore {
  constructor() {
    this.dbPromise = null;
    this.chain = Promise.resolve();  // serialize saves so at most one txn per store is in flight
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

  // Asks the browser not to evict us; reports whether it agreed.
  async requestPersistent() {
    try { return await navigator.storage?.persist?.() ?? false; } catch { return false; }
  }

  async load(treeId) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(treeId);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  // Every tree with a blob on this device.
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

  // Read-join-put in one transaction. `value` = { frame, progress, lastSeq }; the caller must
  // have snapshotted it synchronously (no awaits between lattice state and here).
  save(treeId, value) {
    this.chain = this.chain.then(() => this.saveOnce(treeId, value)).catch(() => {});
    return this.chain;
  }

  async saveOnce(treeId, value) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const txn = db.transaction(STORE, 'readwrite');
      const store = txn.objectStore(STORE);
      const get = store.get(treeId);
      get.onsuccess = () => {
        const stored = get.result;
        const merged = stored ? mergeValues(stored, value) : value;  // synchronous — keeps the txn alive
        store.put(merged, treeId);
      };
      txn.oncomplete = () => resolve();
      txn.onerror = () => reject(txn.error);
      txn.onabort = () => reject(txn.error);
    });
  }
}

// max(lastSeq) is safe: the union frame covers whatever either lastSeq claims to have seen.
function mergeValues(a, b) {
  const lattice = new TreeLattice();
  lattice.join(a.frame);
  lattice.join(b.frame);
  const progress = new ProgressLattice();
  if (a.progress) progress.join(a.progress);
  if (b.progress) progress.join(b.progress);
  return {
    frame: lattice.toFrame(),
    progress: progress.toFrame(),
    lastSeq: Math.max(a.lastSeq ?? 0, b.lastSeq ?? 0),
  };
}
