// The device-tree index: which trees live on this device, their titles, and whether the signed-in
// account has claimed them. The durable structure is the SyncStore blob. Birth is the only writer
// of unclaimed entries, so a claim can never adopt a tree this device didn't bear.

import { fetchMe } from '../../../shell/auth/AuthClient.js';
import { syncSession } from '../../../platform/sync/session.js';
import { localStorageOrNothing } from './browserStorage.js';

const KEY = 'windmill:device-trees';

// Device reads use this document's server answer or the shell's restored bound replica, never a cached face.
function confirmation() {
  return typeof window === 'undefined' ? null : window.wmDeviceConfirmation ?? null;
}

// The holder authorized for device reads, without granting session authority.
export function deviceOwner() {
  return confirmation()?.owner ?? null;
}

const waitingForOwner = new Set();

// An authoritative answer about who holds this device; it also attributes anything unstamped.
export function confirmDeviceOwner(userId) {
  const owner = userId ?? null;
  window.wmDeviceConfirmation = { owner };
  new LocalTreeRegistry().stampUnattributed(owner);
  for (const wake of waitingForOwner) wake();
  waitingForOwner.clear();
  return owner;
}

// Offline /v1/me cannot answer but the shell can, from the replica it restores: this settles on its answer, or after `withinMs`.
export function deviceOwnerAnswered(withinMs = 2000) {
  if (confirmation()) return Promise.resolve();
  return new Promise((resolve) => {
    waitingForOwner.add(resolve);
    setTimeout(resolve, withinMs);
  });
}

export async function resolveDeviceOwner() {
  const me = await fetchMe();
  if (!me && !confirmation()) {
    const engine = await syncSession.opening?.catch(() => null);
    if (engine?.restoring) await engine.restoring;
    const meta = engine?.device?.meta;
    const replica = engine?.device?.activeReplica?.meta;
    const clearing = engine?.closed || engine?.signingOut || meta?.signOut || meta?.deviceCleanup || meta?.clearCredential || meta?.closingAccount;
    if (!confirmation() && !clearing && replica?.state === 'bound') return confirmDeviceOwner(replica.account);
  }
  if (me === undefined) return deviceOwner(); // a blip is not an account change, in either direction
  if (me === null && deviceOwner()) return deviceOwner();
  return confirmDeviceOwner(me?.id ?? null);
}

// A row with no owner field is shown to nobody; `owner: null` is anonymous work, visible to
// everyone on this device. Any other owner sees only its own rows.
function visibleTo(entry, owner) {
  if (entry.owner === undefined) return false;
  if (entry.owner === null) return true;
  return entry.owner === owner;
}

export class LocalTreeRegistry {
  constructor(storage = localStorageOrNothing()) {
    this.storage = storage;
  }

  entries() {
    try {
      return JSON.parse(this.storage.getItem(KEY)) ?? {};
    } catch {
      return {};
    }
  }

  write(entries) {
    try {
      this.storage.setItem(KEY, JSON.stringify(entries));
    } catch {
    }
  }

  // Whether the index takes a write: the row it already has, written back.
  keeps() {
    try {
      const row = this.storage.getItem(KEY) ?? '{}';
      this.storage.setItem(KEY, row);
      return this.storage.getItem(KEY) === row;
    } catch {
      return false;
    }
  }

  list(owner = deviceOwner()) {
    return Object.entries(this.entries())
      .filter(([, entry]) => visibleTo(entry, owner))
      .map(([id, entry]) => ({ id, title: entry.title ?? '', updatedAt: entry.updatedAt ?? 0, claimed: !!entry.claimed }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id, owner = deviceOwner()) {
    return this.list(owner).find((entry) => entry.id === id) ?? null;
  }

  // The owner is stamped at birth so a tree planted offline by a signed-in person is not anonymous
  // work the next account may claim.
  record(id, title, owner = deviceOwner()) {
    const entries = this.entries();
    entries[id] = { title, updatedAt: Date.now(), claimed: false, owner };
    this.write(entries);
  }

  // Rows with no owner field are attributed on first contact: the first server answer of this
  // document load writes itself onto them, once. On a signed-out device that answer is null.
  stampUnattributed(owner) {
    const entries = this.entries();
    let changed = false;
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.owner !== undefined) continue;
      entries[id] = { ...entry, owner };
      changed = true;
    }
    if (changed) this.write(entries);
  }

  // Known entries keep their claim state and their owner: a session never re-attributes a row. An
  // unknown tree arriving through sync is born claimed, stamped only if this load has a confirmed
  // answer.
  touch(id, title) {
    const entries = this.entries();
    const known = entries[id];
    entries[id] = known
      ? { ...known, title, updatedAt: Date.now() }
      : { title, updatedAt: Date.now(), claimed: true, ...(confirmation() ? { owner: deviceOwner() } : {}) };
    this.write(entries);
  }

  rename(id, title) {
    const entries = this.entries();
    if (!entries[id]) return;
    entries[id] = { ...entries[id], title, updatedAt: Date.now() };
    this.write(entries);
  }

  // The server vouched for these rows under this account: stamp them claimed and owned.
  attribute(ids, owner) {
    const entries = this.entries();
    let changed = false;
    for (const id of ids) {
      const entry = entries[id];
      if (!entry || (entry.claimed && entry.owner === owner)) continue;
      entries[id] = { ...entry, claimed: true, owner };
      changed = true;
    }
    if (changed) this.write(entries);
  }

  move(fromId, toId) {
    const entries = this.entries();
    if (!entries[fromId]) return;
    entries[toId] = entries[fromId];
    delete entries[fromId];
    this.write(entries);
  }

  remove(id) {
    const entries = this.entries();
    delete entries[id];
    this.write(entries);
  }
}
