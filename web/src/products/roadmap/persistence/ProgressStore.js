// Local persistence for a user's progress (F1 — Durable progress). The repository's
// authored/seed statuses are the baseline; this overlays the user's own completions,
// in-progress steps, and the timestamps of those actions on top, so starting or
// completing a step sticks across reloads. Keyed by tree id — node ids that no longer
// exist simply don't apply. Best-effort like TreeStore: storage errors are never fatal.

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
