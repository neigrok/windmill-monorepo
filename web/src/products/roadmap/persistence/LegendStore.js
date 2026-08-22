// Local persistence for a tree's color legend (F6 — Custom color legend): the
// ordered kinds (their hues, labels, descriptions) plus whether the key is open.
// Keyed by tree id — hues no node wears simply read as count 0. Best-effort like
// ProgressStore and WorkspaceStore: storage errors are never fatal. The backend
// will own this per tree and sync via the op log (F6 backend tasks); until then
// the legend lives here, the same interim pattern as progress and workspaces.

const KEY_PREFIX = 'windmill:legend:';

export class LegendStore {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  // The saved legend for this tree, or null if there is none.
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
      // storage full or unavailable — persistence is best-effort, never fatal
    }
  }

  // Every tree this device holds a legend for. The account hand-off sweeps by tree id, and
  // residue written for a tree the device index never knew is only reachable through the keys.
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
      // ignore
    }
  }
}
