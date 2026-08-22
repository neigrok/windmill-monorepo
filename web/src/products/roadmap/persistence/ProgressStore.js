// Local persistence for a user's progress (F1 — Durable progress). Keyed by tree id — node ids
// that no longer exist simply don't apply. Best-effort like TreeStore: storage errors are never
// fatal.
//
// Once an account overlay exists this is NOT the truth, and `reconcileOverlay` (model/progress.js)
// is what settles the two. It is not redundant either, which is why signing in does not empty it —
// it holds three things the server's answer does not: marks the server has never heard of (made
// offline or before sign-in, waiting for the reconcile to push them), `startedAt` for a completed
// step (the server keeps one row per node, so the completion overwrote when it began), and the
// whole overlay for a tree the server has never seen — a local-born or anonymous one. It doubles
// as the offline read. The load path writes the reconciled overlay straight back here, so it
// tracks the server between edits rather than lagging it.

const KEY_PREFIX = 'windmill:progress:';

export class ProgressStore {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  // The saved progress for this tree, or null if there is none.
  load(treeId) {
    try {
      const text = this.storage.getItem(KEY_PREFIX + treeId);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  save(treeId, progress) {
    try {
      this.storage.setItem(KEY_PREFIX + treeId, JSON.stringify({
        completed: [...progress.completed],
        inProgress: [...progress.inProgress],
        startedAt: progress.startedAt,
        completedAt: progress.completedAt,
      }));
    } catch {
      // storage full or unavailable — persistence is best-effort, never fatal
    }
  }

  // Every tree this device holds progress for. The account hand-off sweeps by tree id, and
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
