// A tree's legend — ordered kinds plus whether the key is open — keyed by tree id. Storage
// errors are never fatal.

const KEY_PREFIX = 'windmill:legend:';

export class LegendStore {
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

  save(treeId, legend) {
    try {
      this.storage.setItem(KEY_PREFIX + treeId, JSON.stringify({
        kinds: legend.kinds,
        open: legend.open,
      }));
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
