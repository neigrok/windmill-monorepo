// Reads the localStorage progress keys that browsers still hold; nothing writes them. `drainInto`
// moves residue into the SyncStore private lane and clears the key.
// TODO: delete this file once the drain has plausibly run everywhere.
const KEY_PREFIX = 'windmill:progress:';

export class ProgressStore {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  // Marks are stamped by the instant they recorded, under a `legacy` actor; a mark with no
  // instant gets the smallest stamp and loses to everything. Returns how many registers it moved.
  drainInto(treeId, lattice) {
    let saved = null;
    try {
      const text = this.storage.getItem(KEY_PREFIX + treeId);
      saved = text ? JSON.parse(text) : null;
    } catch {
      saved = null;
    }
    if (!saved) return 0;

    const marks = [];
    for (const id of saved.completed ?? []) {
      marks.push({ node: id, status: 'complete', at: `${saved.completedAt?.[id] ?? 1}:0:legacy` });
    }
    for (const id of saved.inProgress ?? []) {
      marks.push({ node: id, status: 'active', at: `${saved.startedAt?.[id] ?? 1}:0:legacy` });
    }
    try {
      lattice.join({ marks });
    } catch {
      return 0;
    }
    this.clear(treeId);
    return marks.length;
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
}
