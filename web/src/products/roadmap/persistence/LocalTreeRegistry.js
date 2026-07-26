// The device-tree index (anon-first-tree F3): which trees live on THIS device, their
// titles, and whether the signed-in account has claimed them. localStorage-backed like
// ProgressStore; the durable structure itself is the SyncStore blob — this is only the
// listing the switcher, the bare-#/app resolver, and the claim sequence read. Birth is
// the only writer of unclaimed entries; a syncing session touching a tree this index
// doesn't know registers it claimed, so the claim path can never adopt a tree this
// device didn't bear.

const KEY = 'windmill:device-trees';

export class LocalTreeRegistry {
  constructor(storage = window.localStorage) {
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
      // storage full or unavailable — the index is best-effort, never fatal
    }
  }

  list() {
    return Object.entries(this.entries())
      .map(([id, entry]) => ({ id, title: entry.title ?? '', updatedAt: entry.updatedAt ?? 0, claimed: !!entry.claimed }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    return this.list().find((entry) => entry.id === id) ?? null;
  }

  // Birth: a tree this device bore, awaiting its account.
  record(id, title) {
    const entries = this.entries();
    entries[id] = { title, updatedAt: Date.now(), claimed: false };
    this.write(entries);
  }

  // A persisting session passed through. Known entries keep their claim state; an unknown
  // tree arriving through sync is a server tree landing on this device — born claimed.
  touch(id, title) {
    const entries = this.entries();
    entries[id] = { title, updatedAt: Date.now(), claimed: entries[id] ? !!entries[id].claimed : true };
    this.write(entries);
  }

  rename(id, title) {
    const entries = this.entries();
    if (!entries[id]) return;
    entries[id] = { ...entries[id], title, updatedAt: Date.now() };
    this.write(entries);
  }

  markClaimed(id) {
    const entries = this.entries();
    if (!entries[id]) return;
    entries[id] = { ...entries[id], claimed: true };
    this.write(entries);
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
