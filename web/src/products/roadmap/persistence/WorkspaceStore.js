// Local persistence for per-node workspaces (F13 — Node workspace): the sub-tasks,
// note, and links a user hangs off each step. Keyed by tree id; persists a plain
// { [nodeId]: workspace } map, so node ids that no longer exist simply never apply.
// Best-effort like ProgressStore — storage errors are never fatal.

const KEY_PREFIX = 'windmill:workspace:';

export class WorkspaceStore {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  // The saved workspaces for this tree, or null if there are none.
  load(treeId) {
    try {
      const text = this.storage.getItem(KEY_PREFIX + treeId);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  save(treeId, byNode) {
    try {
      this.storage.setItem(KEY_PREFIX + treeId, JSON.stringify(byNode));
    } catch {
      // storage full or unavailable — persistence is best-effort, never fatal
    }
  }

  // Every tree this device holds workspaces for. The account hand-off sweeps by tree id, and
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
