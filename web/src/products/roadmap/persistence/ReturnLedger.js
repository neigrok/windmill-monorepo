// The return-recap ledger (P3 — returning is a reward): one localStorage slot per tree
// remembering the completed set the last visit left behind. On the next open the scene
// replays the steps finished SINCE — so reopening a tree travels the newly-lit edges into
// the frontier. Keyed by tree id; best-effort like ProgressStore — storage errors never fatal.
//
// Detection is a pure set-diff, never a timestamp: `since` is every id complete now that the
// prior slot didn't record. That catches completions made on other devices while this tab was
// closed (they carry no local timestamp). The stored `at` only phrases/orders a replay — it is
// never the detection signal, so the diff stays deterministic (no clock, no randomness).

const KEY_PREFIX = 'windmill:return:';

export class ReturnLedger {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  // The completed set the last visit recorded, or null if this tree has never been seen.
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
      // storage full or unavailable — the ledger is best-effort, never fatal
    }
  }

  // Every tree this device holds a return baseline for. The account hand-off sweeps by tree id, and
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

  // The ids complete now that the prior visit did not record — the steps to replay. No prior
  // slot (a first-ever visit) replays nothing. Filtered to nodes the current tree still holds,
  // so a completion whose node has since been deleted never tries to bloom. Pure: no clock.
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
