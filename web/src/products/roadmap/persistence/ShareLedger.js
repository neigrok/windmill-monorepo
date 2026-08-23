// The completed set on screen at the last share, per tree, plus when it was, which share it was,
// and what each posted card stamped. Written only when a share happens. A storage error degrades
// to "never shared", never throws.

const KEY_PREFIX = 'windmill:shared:';
const HISTORY_LIMIT = 12; // covers the ledger's six-period window at two posts a week

export class ShareLedger {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  load(treeId) {
    try {
      const text = this.storage.getItem(KEY_PREFIX + treeId);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  // `count` is the share ordinal, 1 for the first share ever; the caller advances it. `at` is when
  // the card was posted. `delta` is what this card stamped; null falls back to the set difference.
  save(treeId, { completed, at, count, delta = null }) {
    try {
      const prior = this.load(treeId);
      const posted = { at, delta: delta ?? ShareLedger.newCount(completed, prior) };
      const history = [...(prior?.history ?? []), posted].slice(-HISTORY_LIMIT);
      this.storage.setItem(KEY_PREFIX + treeId, JSON.stringify({ completed: [...completed], at, count, history }));
    } catch {
    }
  }

  // Residue for a tree the device index never knew is reachable only through the keys.
  treeIds() {
    try {
      return Object.keys(this.storage).filter((key) => key.startsWith(KEY_PREFIX)).map((key) => key.slice(KEY_PREFIX.length));
    } catch {
      return [];
    }
  }

  clear(treeId) {
    try {
      this.storage.removeItem(KEY_PREFIX + treeId);
    } catch {
    }
  }

  // The ids complete now that the last share didn't carry, filtered to nodes the tree still holds.
  // A pure set-diff, never a clock; a null slot returns nothing.
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

  // What a card posted right now would stamp; no earlier card counts 0, not the whole history.
  static newCount(completed, prior) {
    if (!prior) return 0;
    const shared = new Set(prior.completed ?? []);
    let fresh = 0;
    for (const id of completed) if (!shared.has(id)) fresh += 1;
    return fresh;
  }
}
