// Durable local store for one tree's lattice — the offline half of "the lattice is the
// outbox". One IndexedDB record per tree holds { frame, lastSeq }, written together so a
// crash never tears them. The coverage vector is deliberately NOT persisted (it is rebuilt
// from the next server graft — a fresher, truer statement of coverage than any saved vector,
// and keeping it off disk means no stale claim can outlive its content).
//
// The one subtlety that earns the raw-callback style below: `save` is a read-JOIN-put inside
// a SINGLE transaction. Two tabs of one account share this record; a blind put would let one
// tab clobber the other's unflushed offline edits. Joining the stored frame into the outgoing
// one (via the same CRDT merge the whole system rides) means racy tabs can only ADD
// information. IndexedDB auto-commits a transaction the moment control returns to the event
// loop with no pending request, so the join MUST run synchronously inside get.onsuccess and
// issue the put before yielding — never `await get()` then `await put()` (that is two
// transactions, reopening the clobber window).

import { TreeLattice } from './lattice.js';

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

  // Best-effort durability: ask the browser not to evict us, and report whether it granted it.
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

  async clear(treeId) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(treeId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // Read-join-put in one transaction. `value` = { frame, ackedServerVector (JSON), lastSeq };
  // the caller must have snapshotted it synchronously (no awaits between lattice state and here).
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

// Join two stored values so a racy sibling tab can only add information: the frames merge by
// the CRDT lattice join, the seq by max. max(lastSeq) is safe precisely because the frames are
// joined in the same value — the union frame covers whatever either lastSeq claims seen.
function mergeValues(a, b) {
  const lattice = new TreeLattice();
  lattice.join(a.frame);
  lattice.join(b.frame);
  return { frame: lattice.toFrame(), lastSeq: Math.max(a.lastSeq ?? 0, b.lastSeq ?? 0) };
}
