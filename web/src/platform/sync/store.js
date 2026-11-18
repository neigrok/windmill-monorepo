import { Device, Replica } from '../../../../packages/api-contract/sync/reference/client/replica.js';
import { jcs } from '../../../../packages/api-contract/sync/reference/core/jcs.js';

const keyOf = (...parts) => jcs(parts);
const HEAD = keyOf('head');
const WRITER_SLICE_MS = 25;
const caches = ['confirmed', 'spentIds', 'staging'];
const json = (value) => ({ text: JSON.stringify(value), value });
const equal = (left, right) => left.text === right.text || (left.text.length === right.text.length && jcs(left.value) === jcs(right.value));

export function frozen(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) frozen(item);
  return value;
}

// A sliced step's size, from how long the last one held the writer: t taken in h ms sizes the next t × aim ÷ h,
// at most twice the offer and below it only past the aim, half of WRITER_SLICE_MS. An IndexedDB transaction's
// own cost can pass the aim with a handful of rows, so a step never shrinks below the size it started at.
export class WriterSlice {
  constructor(size) { this.start = this.size = size; }

  record(taken, heldMs) {
    if (taken === 0) return;
    const aim = WRITER_SLICE_MS / 2, upper = Math.min(2 * this.size, 4096);
    if (heldMs <= 0) { this.size = upper; return; }
    const fitting = Math.min(upper, Math.floor(taken * aim / heldMs));
    this.size = heldMs > aim ? Math.max(this.start, fitting) : Math.max(this.size, fitting);
  }
}

class ScopeDemand extends Error {
  constructor(scope) { super('scope hydration required'); this.scope = scope; }
}

// One control record as the store last committed or read it: its key's parts and its JSON text, which a write
// parses afresh and readers share frozen.
class ControlRecord {
  constructor(text, parts) { Object.assign(this, { text, parts }); }
  get value() { return JSON.parse(this.text); }
  get shared() { return (this.frozen ??= frozen(this.value)); }
}

class Generation {
  constructor(version, complete) {
    this.version = version;
    this.complete = complete;
    this.rows = new Map();
    this.types = new Set();
  }

  get shared() { return (this.frozen ??= Object.freeze(Object.fromEntries(this.rows))); }

  rowsOf(type) { return [...this.rows].filter(([, row]) => row.t === type); }

  set(id, row) {
    this.frozen = undefined;
    if (row === undefined) this.rows.delete(id);
    else this.rows.set(id, row);
  }
}

function controlsOf(device, revision) {
  const records = new Map();
  for (const replica of device.replicas) replica.storageHandle ??= replica.id;
  records.set(HEAD, { active: device.activeReplica.storageHandle, meta: device.meta, revision });
  for (const replica of device.replicas) {
    const handle = replica.storageHandle;
    records.set(keyOf('replica', handle), replica.meta);
    for (const kind of ['cursors', 'known']) for (const [scope, value] of Object.entries(replica[kind])) records.set(keyOf(kind, handle, scope), value);
    for (const [product, rows] of Object.entries(replica.device)) for (const [key, value] of Object.entries(rows)) records.set(keyOf('device', handle, product, key), value);
    for (const entry of replica.outbox) records.set(keyOf('outbox', handle, entry.localId), entry);
    replica.notices.forEach((notice, index) => records.set(keyOf('notice', handle, index), notice));
  }
  return records;
}

function deviceOf(controls, { shared }) {
  const valueFrom = (record) => (shared ? record.shared : record.value);
  const head = controls.records.get(HEAD)?.value;
  if (!head) return null;
  const replicas = new Map();
  for (const record of controls.records.values()) {
    const [kind, handle] = record.parts;
    if (kind !== 'replica') continue;
    const replica = new Replica({ meta: valueFrom(record) });
    replica.storageHandle = handle;
    replica.cacheSizes = {};
    replica.cacheGenerations = {};
    replica.cachePointers = {};
    replica.loadedCaches = new Set();
    replicas.set(handle, replica);
  }
  for (const record of controls.records.values()) {
    const [kind, handle, scope, id] = record.parts;
    const replica = replicas.get(handle);
    if (!replica || kind === 'replica') continue;
    const value = valueFrom(record);
    if (kind === 'outbox') replica.outbox.push(value);
    else if (kind === 'notice') replica.notices[scope] = value;
    else if (kind === 'cache') {
      replica[scope][id] = scope === 'staging' ? { digest: value.digest, rows: {} } : {};
      replica.cachePointers[`${scope}:${id}`] = value;
      replica.cacheGenerations[`${scope}:${id}`] = `${value.generation}:${value.version ?? 0}`;
      if (scope === 'confirmed') replica.cacheSizes[id] = value.count;
    } else if (kind === 'device') (replica.device[scope] ??= {})[id] = value;
    else if (kind === 'cursors' || kind === 'known') replica[kind][scope] = value;
  }
  const device = new Device({ replicas: [], active: null, meta: head.meta });
  device.replicas = [...replicas.values()];
  device.activeReplica = replicas.get(head.active);
  if (!device.activeReplica) throw new Error('invalid active replica');
  return { device, revision: head.revision };
}

export class IndexedDBStore {
  constructor(database, keyRange) {
    this.database = database;
    this.generationRows = (generation) => keyRange.bound([generation], [generation, []]);
    this.closed = false;
    this.controls = null;
    this.generations = new Map();
    this.garbage = new Set();
    database.onversionchange = () => this.close();
  }

  static async open({ indexedDB = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange, name = 'wm-sync', newReplicaId }) {
    if (!indexedDB || !keyRange) throw new Error('sync storage unavailable');
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
    const store = new IndexedDBStore(database, keyRange);
    store.reopen = () => IndexedDBStore.open({ indexedDB, keyRange, name, newReplicaId });
    try { await store.transact((device) => device, { initialize: newReplicaId }); return store; }
    catch (error) { store.close(); throw error; }
  }

  read(scopes = 'all') {
    return this.transact((device) => device, { readonly: true, scopes });
  }

  generationOf(pointer) {
    const version = pointer.version ?? 0;
    const known = this.generations.get(pointer.generation);
    if (known?.version === version) return known;
    const fresh = new Generation(version, false);
    this.generations.set(pointer.generation, fresh);
    return fresh;
  }

  transact(change, { readonly = false, initialize, beforeCommit, scopes = [] } = {}) {
    if (this.closed) return Promise.reject(new Error('sync store closed'));
    const queued = performance.now();
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(['records', 'rows'], readonly ? 'readonly' : 'readwrite', { durability: 'strict' });
      const table = transaction.objectStore('records'), rows = transaction.objectStore('rows');
      let failure, answer, started, committed = () => {}, rowReads = 0, rowWrites = 0, waiting = 0;
      const guarded = (step) => (...args) => {
        try { step(...args); } catch (error) { failure = error; transaction.abort(); }
      };
      const tracked = new WeakMap();
      let loaded, controls;

      const awaitRead = (request, accept) => {
        waiting++;
        request.onsuccess = guarded(() => {
          accept(request.result);
          if (--waiting === 0) run();
        });
      };
      const hydrate = (replica, kind, scope, { full, keys = [], types = [] }) => {
        const cache = replica[kind][scope];
        const map = kind === 'staging' ? cache.rows : cache;
        const pointer = replica.cachePointers[`${kind}:${scope}`];
        const generation = this.generationOf(pointer);
        const state = tracked.get(map);
        const place = (id, row) => { map[id] = row; state.base.set(id, row); };
        const remember = (records) => {
          for (const record of records) generation.set(record.key[1], frozen(record.value));
          rowReads += records.length;
        };
        const fill = () => {
          if (!readonly) { for (const [id, row] of generation.rows) place(id, row); return; }
          if (kind === 'staging') cache.rows = generation.shared;
          else replica[kind][scope] = generation.shared;
        };
        if (full) {
          replica.loadedCaches.add(`${kind}:${scope}`);
          if (generation.complete) { fill(); return; }
          awaitRead(rows.getAll(this.generationRows(pointer.generation)), (records) => {
            for (const id of [...generation.rows.keys()]) generation.set(id, undefined);
            remember(records);
            generation.complete = true;
            fill();
          });
          return;
        }
        for (const type of types) {
          if (generation.complete || generation.types.has(type)) { for (const [id, row] of generation.rowsOf(type)) place(id, row); continue; }
          awaitRead(rows.index('type').getAll([pointer.generation, type]), (records) => {
            remember(records);
            generation.types.add(type);
            for (const [id, row] of generation.rowsOf(type)) place(id, row);
          });
        }
        for (const id of keys) {
          if (generation.rows.has(id)) { place(id, generation.rows.get(id)); continue; }
          if (generation.complete) continue;
          awaitRead(rows.get([pointer.generation, id]), (record) => {
            if (!record) return;
            remember([record]);
            place(id, record.value);
          });
        }
      };

      const begin = () => {
        loaded = deviceOf(controls, { shared: readonly });
        if (!loaded) {
          if (!initialize) throw new Error('sync store uninitialized');
          const replica = Replica.fresh({ replica: initialize() });
          replica.storageHandle = replica.id;
          loaded = { device: new Device({ active: replica.id, replicas: [replica.toJSON()] }), revision: 0 };
          loaded.device.activeReplica.storageHandle = replica.storageHandle;
          Object.assign(loaded.device.activeReplica, { cacheSizes: {}, cacheGenerations: {}, cachePointers: {}, loadedCaches: new Set() });
        }
        const selections = typeof scopes === 'function' ? scopes(loaded.device) : scopes;
        waiting = 1;
        for (const replica of loaded.device.replicas) for (const kind of caches) for (const [scope, cache] of Object.entries(replica[kind])) {
          const pointer = replica.cachePointers[`${kind}:${scope}`];
          tracked.set(kind === 'staging' ? cache.rows : cache, { ...pointer, base: new Map() });
          const selected = selections === 'all' ? [scope] : selections.filter((item) => (typeof item === 'string' ? item === scope : item.scope === scope && (!item.handle || item.handle === replica.storageHandle)));
          if (!selected.length) continue;
          const full = selected.some((item) => typeof item === 'string' || (!item.keys && !item.type));
          hydrate(replica, kind, scope, { full, keys: [...new Set(selected.flatMap((item) => item.keys ?? []))],
            types: [...new Set(selected.map((item) => item.type).filter(Boolean))] });
        }
        if (--waiting === 0) run();
      };

      const run = () => {
        try {
          const previous = loaded.device.activeReplica.id;
          const result = change(loaded.device, (scope) => {
            const replica = loaded.device.activeReplica;
            if (caches.some((kind) => Object.hasOwn(replica[kind], scope) && !replica.loadedCaches.has(`${kind}:${scope}`))) throw new ScopeDemand(scope);
          });
          if (result?.then) throw new Error('sync transaction callback must be synchronous');
          const persisted = readonly ? { changed: false, revision: loaded.revision } : persist();
          beforeCommit?.({ transaction, changed: persisted.changed, records: persisted.records ?? controlsOf(loaded.device, loaded.revision) });
          answer = { result, device: loaded.device, revision: persisted.revision, changed: persisted.changed, previous, active: loaded.device.activeReplica.id };
        } catch (error) {
          if (!(error instanceof ScopeDemand)) throw error;
          const replica = loaded.device.activeReplica;
          waiting = 1;
          for (const kind of caches) {
            if (Object.hasOwn(replica[kind], error.scope) && !replica.loadedCaches.has(`${kind}:${error.scope}`)) hydrate(replica, kind, error.scope, { full: true });
          }
          if (--waiting === 0) run();
        }
      };

      const persist = () => {
        const after = controlsOf(loaded.device, loaded.revision);
        const rowChanges = [];
        const alive = new Set();
        for (const replica of loaded.device.replicas) for (const kind of caches) for (const [scope, cache] of Object.entries(replica[kind])) {
          const map = kind === 'staging' ? cache.rows : cache;
          const state = tracked.get(map) ?? { generation: crypto.randomUUID(), count: 0, base: new Map(), created: true };
          const written = new Map();
          let count = state.count;
          for (const id of Object.keys(map)) {
            const old = state.base.get(id), row = map[id];
            if (old === row || (old !== undefined && equal(json(row), json(old)))) continue;
            written.set(id, frozen(row));
            count += Number(old === undefined);
          }
          for (const id of state.base.keys()) if (!Object.hasOwn(map, id)) { written.set(id, undefined); count--; }
          for (const [id, row] of written) {
            rowWrites++;
            if (row === undefined) rows.delete([state.generation, id]);
            else rows.put({ key: [state.generation, id], generation: state.generation, type: [state.generation, row.t], value: row });
          }
          const version = (state.version ?? 0) + Number(written.size > 0);
          rowChanges.push({ generation: state.generation, from: state.version ?? 0, version, created: state.created === true, written });
          alive.add(state.generation);
          after.set(keyOf('cache', replica.storageHandle, kind, scope), { generation: state.generation, count, version, ...(kind === 'staging' ? { digest: cache.digest } : {}) });
        }
        const texts = new Map([...after].map(([key, value]) => [key, JSON.stringify(value)]));
        const differs = (key) => {
          const before = controls.records.get(key);
          return !before || !equal({ text: texts.get(key), value: after.get(key) }, before);
        };
        const removed = [...controls.records.keys()].filter((key) => !after.has(key));
        const dead = [...controls.records.values()].filter(({ parts: [kind] }) => kind === 'cache')
          .map((record) => record.shared.generation).filter((generation) => !alive.has(generation));
        const differing = [...after.keys()].filter(differs);
        const changed = rowWrites > 0 || removed.length > 0 || differing.length > 0;
        if (!changed) return { changed, revision: loaded.revision, records: after };
        const revision = loaded.revision + 1;
        after.get(HEAD).revision = revision;
        texts.set(HEAD, JSON.stringify(after.get(HEAD)));
        for (const key of removed) table.delete(key);
        for (const key of new Set([HEAD, ...differing])) table.put({ key, value: after.get(key) });
        for (const generation of dead) table.put({ key: keyOf('garbage', generation), value: generation });
        committed = () => {
          const records = new Map([...texts].map(([key, text]) => {
            const before = controls.records.get(key);
            return [key, before?.text === text ? before : new ControlRecord(text, before?.parts ?? JSON.parse(key))];
          }));
          if ((this.controls?.revision ?? -1) <= revision) this.controls = { revision, records };
          for (const generation of dead) { this.generations.delete(generation); this.garbage.add(generation); }
          for (const { generation, from, version, created, written } of rowChanges) {
            const known = created ? new Generation(0, true) : this.generations.get(generation);
            if (!known || known.version !== from) {
              if (known?.version !== version) this.generations.delete(generation);
              continue;
            }
            for (const [id, row] of written) known.set(id, row);
            known.version = version;
            this.generations.set(generation, known);
          }
        };
        return { changed, revision, records: after };
      };

      const head = table.get(HEAD);
      head.onsuccess = guarded(() => {
        started = performance.now();
        const revision = head.result?.value.revision;
        if (head.result && this.controls?.revision === revision) { controls = this.controls; begin(); return; }
        const all = table.getAll();
        all.onsuccess = guarded(() => {
          const records = new Map();
          for (const { key, value } of all.result) {
            const parts = JSON.parse(key);
            if (parts[0] === 'garbage') this.garbage.add(value);
            else records.set(key, new ControlRecord(JSON.stringify(value), parts));
          }
          controls = this.controls = { revision: records.get(HEAD)?.value.revision, records };
          const pointed = new Set([...records.values()].filter(({ parts: [kind] }) => kind === 'cache').map((record) => record.shared.generation));
          for (const generation of this.generations.keys()) if (!pointed.has(generation)) this.generations.delete(generation);
          begin();
        });
      });
      transaction.oncomplete = () => {
        committed();
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
      const pending = [...this.garbage];
      const cleaned = [];
      let deleted = 0;
      const next = () => {
        const generation = pending.shift();
        if (generation === undefined || deleted >= limit) return;
        const remaining = limit - deleted;
        const clean = rows.getAllKeys(this.generationRows(generation), remaining);
        clean.onsuccess = () => {
          for (const key of clean.result) rows.delete(key);
          deleted += clean.result.length;
          if (clean.result.length < remaining) { records.delete(keyOf('garbage', generation)); cleaned.push(generation); }
          next();
        };
      };
      next();
      transaction.oncomplete = () => {
        for (const generation of cleaned) this.garbage.delete(generation);
        resolve(deleted);
      };
      transaction.onabort = () => reject(transaction.error ?? new Error('sync cleanup aborted'));
    });
  }

  close() { this.closed = true; this.database.close(); }
}
