import { Device, Replica } from '../../../../packages/api-contract/sync/reference/client/replica.js';
import { frozen } from './store.js';

const CACHES = ['confirmed', 'spentIds', 'staging'];
const LISTS = ['notices', 'journal', 'inverses', 'cancellations'];
const mapValues = (object, map) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, map(value, key)]));
const copied = (value) => structuredClone(value);
const kept = (value) => frozen(structuredClone(value));

// A replica as `value` hands over its controls and `rows` each scope's rows; every row is in memory, so every cache is loaded.
function replicaOf(source, value, rows) {
  const replica = new Replica({ meta: {} });
  replica.storageHandle = source.storageHandle;
  replica.meta = value(source.meta);
  replica.cursors = mapValues(source.cursors, value);
  replica.known = mapValues(source.known, value);
  replica.device = mapValues(source.device, (product) => mapValues(product, value));
  replica.outbox = source.entries().map(value);
  for (const list of LISTS) replica[list] = source[list].map(value);
  replica.confirmed = mapValues(source.confirmed, (scoped, scope) => rows(scoped, source, 'confirmed', scope));
  replica.spentIds = mapValues(source.spentIds, (scoped, scope) => rows(scoped, source, 'spentIds', scope));
  replica.staging = mapValues(source.staging, (staged, scope) => ({ digest: staged.digest, rows: rows(staged.rows, source, 'staging', scope) }));
  replica.loadedCaches = new Set(CACHES.flatMap((kind) => Object.keys(replica[kind]).map((scope) => `${kind}:${scope}`)));
  return replica;
}

function deviceOf(source, value, rows) {
  const device = new Device({ replicas: [], active: null });
  device.meta = value(source.meta);
  device.replicas = source.replicas.map((replica) => replicaOf(replica, value, rows));
  device.activeReplica = device.replicas[source.replicas.indexOf(source.activeReplica)];
  return device;
}

// What a write must change for the store to call it a change, rows aside: every control and which scopes hold rows.
function controlsOf(device) {
  return JSON.stringify({ meta: device.meta, active: device.activeReplica.storageHandle, replicas: device.replicas.map((replica) => ({
    handle: replica.storageHandle, meta: replica.meta, cursors: replica.cursors, known: replica.known, device: replica.device,
    outbox: replica.outbox, ...Object.fromEntries(LISTS.map((list) => [list, replica[list]])),
    digests: mapValues(replica.staging, (staged) => staged.digest),
    scopes: CACHES.map((kind) => Object.keys(replica[kind]).sort()),
  })) });
}

// The engine's store interface over a device held in memory as long as the page, for a browser that offers no IndexedDB
// (engine.md §2.5); its coordination name is its own, so its tab is a device of its own.
export class MemoryStore {
  // `held` is the device every connection of this store shares: its name and what was last committed.
  constructor(held) {
    this.held = held;
    this.coordination = held.name;
    this.closed = false;
  }

  static async open({ newReplicaId }) {
    const store = new MemoryStore({ name: `memory:${crypto.randomUUID()}`, committed: null });
    await store.transact((device) => device, { initialize: newReplicaId });
    return store;
  }

  async reopen() {
    return new MemoryStore(this.held);
  }

  read(scopes = 'all') {
    return this.transact((device) => device, { readonly: true, scopes });
  }

  async transact(change, { readonly = false, initialize } = {}) {
    if (this.closed) throw new Error('sync store closed');
    const started = performance.now();
    const base = this.held.committed ?? this.born(initialize);
    const device = readonly ? deviceOf(base.device, (value) => value, (rows) => rows) : deviceOf(base.device, copied, (rows) => ({ ...rows }));
    const previous = device.activeReplica.id;
    const result = change(device, () => {});
    if (result?.then) throw new Error('sync transaction callback must be synchronous');
    const next = readonly ? { committed: base, rowWrites: 0 } : this.commit(device, base);
    this.held.committed = next.committed;
    this.lastTransaction = { rowReads: 0, rowWrites: next.rowWrites, queueMs: 0, writerMs: performance.now() - started };
    return { result, device, revision: next.committed.revision, changed: next.committed !== base, previous,
      active: device.activeReplica.id, measurement: this.lastTransaction };
  }

  born(initialize) {
    if (!initialize) throw new Error('sync store uninitialized');
    const replica = Replica.fresh({ replica: initialize() });
    const device = new Device({ active: replica.id, replicas: [replica.toJSON()] });
    device.activeReplica.storageHandle = replica.id;
    return { device, revision: 0, controls: null };
  }

  // The device a write leaves, kept as copies the store owns: a row the write did not replace stays the one it read, and a
  // scope whose rows it left alone keeps their object.
  commit(device, base) {
    for (const replica of device.replicas) replica.storageHandle ??= replica.id;
    const before = new Map(base.device.replicas.map((replica) => [replica.storageHandle, replica]));
    let rowWrites = 0;
    const settled = (rows, replica, kind, scope) => {
      const stored = before.get(replica.storageHandle);
      const committedRows = kind === 'staging' ? stored?.staging[scope]?.rows : stored?.[kind][scope];
      const written = Object.keys(rows).filter((id) => rows[id] !== committedRows?.[id]).length
        + Object.keys(committedRows ?? {}).filter((id) => !Object.hasOwn(rows, id)).length;
      if (committedRows && written === 0) return committedRows;
      rowWrites += written;
      return Object.freeze(mapValues(rows, (row, id) => (row === committedRows?.[id] ? row : kept(row))));
    };
    const committed = deviceOf(device, kept, settled);
    const controls = controlsOf(committed);
    if (rowWrites === 0 && controls === base.controls) return { committed: base, rowWrites };
    return { committed: { device: committed, revision: base.revision + 1, controls }, rowWrites };
  }

  async cleanup() {
    if (this.closed) throw new Error('sync store closed');
    return 0;
  }

  close() { this.closed = true; }
}
