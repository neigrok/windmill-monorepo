// The share ledger (brief #20 — the repeat-share surface): one localStorage slot per tree
// remembering the completed set that was on screen the last time this user actually SHARED,
// when that was, and which share it was. The progress card's "since you last shared" is the
// diff against this slot and nothing else.
//
// It looks like ReturnLedger and is deliberately not it. ReturnLedger re-baselines on every
// completion — it answers "what has this device not yet witnessed", so its diff collapses to
// empty the instant you finish a step yourself. This one is written ONLY when a share happens,
// which is the whole reason it is a separate file: a baseline that survives your own work is
// the only honest way to say "since you last shared" without per-node server timestamps.
//
// Best-effort like every store here — a storage error degrades to "never shared", never throws.

const KEY_PREFIX = 'windmill:shared:';

export class ShareLedger {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  // The last share's slot, or null for a tree this user has never shared.
  load(treeId) {
    try {
      const text = this.storage.getItem(KEY_PREFIX + treeId);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  // `count` is the share ordinal — 1 for the first share ever, and what the card prints as
  // "Update #N". The caller advances it; the ledger just remembers.
  save(treeId, { completed, at, count }) {
    try {
      this.storage.setItem(KEY_PREFIX + treeId, JSON.stringify({ completed: [...completed], at, count }));
    } catch {
      // storage full or unavailable — the ledger is best-effort, never fatal
    }
  }

  clear(treeId) {
    try {
      this.storage.removeItem(KEY_PREFIX + treeId);
    } catch {
      // ignore
    }
  }

  // The ids complete now that the last share didn't carry — the steps the progress card lights.
  // A pure set-diff, never a clock: it stays true for someone who posts fortnightly and it
  // catches work done on another device, which carries no local timestamp at all. Filtered to
  // nodes the tree still holds, so a completion whose node was since deleted can't be claimed.
  // Never shared (a null slot) returns nothing — the first share is not a diff.
  static since(currentCompletedSet, prior, statesMap) {
    if (!prior) return [];
    const shared = new Set(prior.completed ?? []);
    const since = [];
    for (const id of currentCompletedSet) {
      if (shared.has(id)) continue;
      if (!statesMap.has(id)) continue;
      since.push(id);
    }
    return since;
  }
}
