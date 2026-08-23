// Which milestones have already offered their share, per tree, so each is offered once ever. A
// storage error risks a second offer, never a failure.

const KEY_PREFIX = 'windmill:milestones:';

export class MilestoneLedger {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  load(treeId) {
    try {
      const text = this.storage.getItem(KEY_PREFIX + treeId);
      return new Set(text ? JSON.parse(text) : []);
    } catch {
      return new Set();
    }
  }

  has(treeId, milestoneId) {
    return this.load(treeId).has(milestoneId);
  }

  markOffered(treeId, milestoneId) {
    try {
      const offered = this.load(treeId);
      offered.add(milestoneId);
      this.storage.setItem(KEY_PREFIX + treeId, JSON.stringify([...offered]));
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
}
