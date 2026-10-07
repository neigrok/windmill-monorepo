import { Device, Replica } from './client/replica.js';
import { jcs } from './core/jcs.js';

const keyOf = (...parts) => jcs(parts);
const caches = ['confirmed', 'spentIds', 'staging'];
const equal = (a, b) => jcs(a ?? null) === jcs(b ?? null);

function controlsOf(device, revision) {
  const records = new Map();
  const add = (key, value) => records.set(key, structuredClone(value));
  for (const replica of device.replicas) replica.storageHandle ??= replica.id;
  add(keyOf('head'), { active: device.activeReplica.storageHandle, meta: device.meta, revision });
  for (const replica of device.replicas) {
    const handle = replica.storageHandle;
    add(keyOf('replica', handle), replica.meta);
    for (const kind of ['cursors', 'known']) for (const [scope, value] of Object.entries(replica[kind])) add(keyOf(kind, handle, scope), value);
    for (const [product, rows] of Object.entries(replica.device)) for (const [key, value] of Object.entries(rows)) add(keyOf('device', handle, product, key), value);
    for (const entry of replica.outbox) add(keyOf('outbox', handle, entry.localId), entry);
    replica.notices.forEach((notice, index) => add(keyOf('notice', handle, index), notice));
  }
  return records;
}

function deviceOf(records) {
  const head = records.get(keyOf('head'));
  if (!head) return null;
  const replicas = new Map();
  for (const [key, value] of records) {
    const [kind, handle] = JSON.parse(key);
    if (kind !== 'replica') continue;
    const replica = new Replica({ meta: value });
    replica.storageHandle = handle;
    replica.cacheSizes = {};
    replica.cacheGenerations = {};
    replica.loadedCaches = new Set();
    replicas.set(handle, replica);
  }
  for (const [key, value] of records) {
    const [kind, handle, scope, id] = JSON.parse(key);
    const replica = replicas.get(handle);
    if (!replica) continue;
    const copy = structuredClone(value);
    if (kind === 'outbox') replica.outbox.push(copy);
    else if (kind === 'notice') replica.notices[scope] = copy;
    else if (kind === 'cache') {
      replica[scope][id] = scope === 'staging' ? { digest: copy.digest, rows: {} } : {};
      replica.cacheGenerations[`${scope}:${id}`] = `${copy.generation}:${copy.version ?? 0}`;
      if (scope === 'confirmed') replica.cacheSizes[id] = copy.count;
    } else if (kind === 'device') (replica.device[scope] ??= {})[id] = copy;
    else if (kind === 'cursors' || kind === 'known') replica[kind][scope] = copy;
  }
  const device = new Device({ replicas: [], active: null, meta: head.meta });
  device.replicas = [...replicas.values()];
  device.activeReplica = replicas.get(head.active);
  if (!device.activeReplica) throw new Error('invalid active replica');
  return { device, revision: head.revision };
}

export class IndexedDBStore {
  constructor(database) {
    this.database = database;
    this.closed = false;
    database.onversionchange = () => this.close();
  }

  static async open({ indexedDB = globalThis.indexedDB, name = 'wm-sync', newReplicaId }) {
    if (!indexedDB) throw new Error('sync storage unavailable');
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      let abandoned = false;
      request.onupgradeneeded = ({ oldVersion }) => {
        const database = request.result, transaction = request.transaction;
        transaction.onabort = () => database.close();
        if (abandoned) { transaction.abort(); return; }
        const records = oldVersion === 0 ? database.createObjectStore('records', { keyPath: 'key' }) : transaction.objectStore('records');
        const rows = database.createObjectStore('rows', { keyPath: 'key' });
        rows.createIndex('generation', 'generation');
        rows.createIndex('type', 'type');
        if (oldVersion === 0) return;
        const pointers = new Map();
        const scan = records.openCursor();
        scan.onsuccess = () => {
          const cursor = scan.result;
          if (!cursor) { for (const [key, value] of pointers) records.put({ key, value }); return; }
          const [kind, handle, scope, id] = JSON.parse(cursor.key);
          if (['confirmed', 'spentIds', 'stagedRow'].includes(kind)) {
            const collection = kind === 'stagedRow' ? 'staging' : kind;
            const key = keyOf('cache', handle, collection, scope);
            const generation = keyOf(handle, collection, scope);
            const pointer = pointers.get(key) ?? { generation, count: 0 };
            pointer.count++;
            pointers.set(key, pointer);
            rows.put({ key: [generation, id], generation, type: [generation, cursor.value.value.t], value: cursor.value.value });
            cursor.delete();
          } else if (kind === 'staging') {
            const key = keyOf('cache', handle, 'staging', scope);
            const pointer = pointers.get(key) ?? { generation: keyOf(handle, 'staging', scope), count: 0 };
            pointer.digest = cursor.value.value;
            pointers.set(key, pointer);
            cursor.delete();
          }
          cursor.continue();
        };
      };
      request.onsuccess = () => {
        if (abandoned) { request.result.close(); return; }
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => { abandoned = true; reject(new Error('sync storage blocked')); };
    });
    const store = new IndexedDBStore(database);
    store.reopen = () => IndexedDBStore.open({ indexedDB, name, newReplicaId });
    try { await store.transact((device) => device, { initialize: newReplicaId }); return store; }
    catch (error) { store.close(); throw error; }
  }

  read(scopes = 'all') {
    return this.transact((device) => device, { readonly: true, scopes });
  }

  transact(change, { readonly = false, initialize, beforeCommit, scopes = [] } = {}) {
    if (this.closed) return Promise.reject(new Error('sync store closed'));
    const queued = performance.now();
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(['records', 'rows'], readonly ? 'readonly' : 'readwrite', { durability: 'strict' });
      const table = transaction.objectStore('records'), rows = transaction.objectStore('rows');
      let failure, answer, started, rowReads = 0, rowWrites = 0;
      const request = table.getAll();
      request.onsuccess = () => {
        started = performance.now();
        try {
          const before = new Map(request.result.map(({ key, value }) => [key, value]));
          let loaded = deviceOf(before);
          if (!loaded) {
            if (!initialize) throw new Error('sync store uninitialized');
            const replica = Replica.fresh({ replica: initialize() });
            replica.storageHandle = replica.id;
            loaded = { device: new Device({ active: replica.id, replicas: [replica.toJSON()] }), revision: 0 };
            loaded.device.activeReplica.storageHandle = replica.storageHandle;
          }
          const tracked = new WeakMap();
          const selections = typeof scopes === 'function' ? scopes(loaded.device) : scopes;
          let pending = 1;
          const finishRead = () => { if (--pending === 0) commit(); };
          for (const replica of loaded.device.replicas) for (const kind of caches) for (const [scope, cache] of Object.entries(replica[kind])) {
            const pointer = before.get(keyOf('cache', replica.storageHandle, kind, scope));
            const map = kind === 'staging' ? cache.rows : cache;
            const selected = selections === 'all' ? [{ scope }] : selections.filter((item) => (typeof item === 'string' ? item === scope : item.scope === scope && (!item.handle || item.handle === replica.storageHandle)));
            const full = selected.some((item) => typeof item === 'string' || (!item.keys && !item.type));
            const keys = full ? undefined : selected.flatMap((item) => item.keys ?? []);
            const state = { ...pointer, before: {} };
            if (full) replica.loadedCaches.add(`${kind}:${scope}`);
            tracked.set(map, state);
            if (!selected.length) continue;
            const accept = (record) => { if (record) { if (!Object.hasOwn(map, record.key[1])) rowReads++; map[record.key[1]] = structuredClone(record.value); state.before[record.key[1]] = structuredClone(record.value); } };
            if (!full) {
              for (const type of new Set(selected.map((item) => item.type).filter(Boolean))) {
                pending++;
                const read = rows.index('type').getAll([pointer.generation, type]);
                read.onsuccess = () => { read.result.forEach(accept); finishRead(); };
              }
              for (const key of new Set(keys)) {
                pending++;
                const read = rows.get([pointer.generation, key]);
                read.onsuccess = () => { accept(read.result); finishRead(); };
              }
            } else {
              pending++;
              const read = rows.index('generation').getAll(pointer.generation);
              read.onsuccess = () => { read.result.forEach(accept); finishRead(); };
            }
          }
          const commit = () => {
            try {
              const previous = loaded.device.activeReplica.id;
              const result = change(loaded.device);
              if (result?.then) throw new Error('sync transaction callback must be synchronous');
              const after = controlsOf(loaded.device, loaded.revision);
              const alive = new Set();
              for (const replica of loaded.device.replicas) for (const kind of caches) for (const [scope, cache] of Object.entries(replica[kind])) {
                const map = kind === 'staging' ? cache.rows : cache;
                const state = tracked.get(map) ?? { generation: crypto.randomUUID(), count: 0, before: {} };
                let count = state.count, edited = false;
                for (const key of new Set([...Object.keys(state.before), ...Object.keys(map)])) {
                  const old = state.before[key], value = map[key];
                  if (equal(old, value)) continue;
                  edited = true;
                  count += Number(value !== undefined) - Number(old !== undefined);
                  if (!readonly) {
                    rowWrites++;
                    if (value === undefined) rows.delete([state.generation, key]);
                    else rows.put({ key: [state.generation, key], generation: state.generation, type: [state.generation, value.t], value: structuredClone(value) });
                  }
                }
                alive.add(state.generation);
                after.set(keyOf('cache', replica.storageHandle, kind, scope), { generation: state.generation, count, version: (state.version ?? 0) + Number(edited), ...(kind === 'staging' ? { digest: cache.digest } : {}) });
              }
              for (const [key, value] of before) {
                const [kind] = JSON.parse(key);
                if (kind === 'garbage') after.set(key, value);
                if (kind === 'cache' && !alive.has(value.generation)) after.set(keyOf('garbage', value.generation), value.generation);
              }
              const changed = !readonly && (rowWrites > 0 || before.size !== after.size || [...after].some(([key, value]) => !equal(before.get(key), value)));
              const revision = loaded.revision + Number(changed);
              if (changed) {
                after.get(keyOf('head')).revision = revision;
                for (const key of before.keys()) if (!after.has(key)) table.delete(key);
                for (const [key, value] of after) if (!equal(before.get(key), value)) table.put({ key, value });
              }
              beforeCommit?.({ transaction, changed, records: after });
              answer = { result, device: loaded.device, revision, changed, previous, active: loaded.device.activeReplica.id };
            } catch (error) { failure = error; transaction.abort(); }
          };
          finishRead();
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => {
        this.lastTransaction = { rowReads, rowWrites, queueMs: started - queued, writerMs: performance.now() - queued };
        resolve({ ...answer, measurement: this.lastTransaction });
      };
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('sync transaction aborted'));
      transaction.onerror = () => { failure ??= transaction.error; };
    });
  }

  cleanup(limit = 128) {
    if (this.closed) return Promise.reject(new Error('sync store closed'));
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(['records', 'rows'], 'readwrite');
      const records = transaction.objectStore('records'), rows = transaction.objectStore('rows');
      let deleted = 0;
      const scan = records.openCursor();
      scan.onsuccess = () => {
        const cursor = scan.result;
        if (!cursor || deleted >= limit) return;
        if (JSON.parse(cursor.key)[0] !== 'garbage') { cursor.continue(); return; }
        const remaining = limit - deleted;
        const clean = rows.index('generation').getAllKeys(cursor.value.value, remaining);
        clean.onsuccess = () => {
          for (const key of clean.result) rows.delete(key);
          deleted += clean.result.length;
          if (clean.result.length < remaining) { cursor.delete(); cursor.continue(); }
        };
      };
      transaction.oncomplete = () => resolve(deleted);
      transaction.onabort = () => reject(transaction.error ?? new Error('sync cleanup aborted'));
    });
  }

  close() { this.closed = true; this.database.close(); }
}
