// The completed set the last visit left behind, per tree, so the next open can replay the steps
// finished since. Detection is a pure set-diff, never a timestamp; the stored `at` only orders the
// replay. Storage errors are never fatal.

const KEY_PREFIX = 'windmill:return:';

export class ReturnLedger {
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

  save(treeId, { completed, at }) {
    try {
      this.storage.setItem(KEY_PREFIX + treeId, JSON.stringify({ completed: [...completed], at }));
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

  // The ids complete now that the prior visit did not record, filtered to nodes the tree still holds.
  static since(currentCompletedSet, prior, statesMap) {
    if (!prior) return [];
    const priorCompleted = new Set(prior.completed ?? []);
    const since = [];
    for (const id of currentCompletedSet) {
      if (priorCompleted.has(id)) continue;
      if (!statesMap.has(id)) continue;
      since.push(id);
    }
    return since;
  }
}
