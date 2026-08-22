// LEGACY RESIDUE. Progress lives in the private lane of the SyncStore blob now
// (sync/progressLattice.js), and nothing WRITES these keys any more — but real browsers are still
// holding them from before the lane, and not all of it is redundant. A mark the server already
// knows is; a mark made offline, or before signing in, or in the minutes around the lane's own
// deploy, reached nothing but this key. Dropping the reader outright would have discarded exactly
// the marks that were only ever here — so `drainInto` moves them into the lane first, and only
// then is the key cleared.
//
// Delete this file once the drain has plausibly run everywhere; `treeIds` + `clear` are what the
// device sweep in sync/localTrees.js needs until then.
const KEY_PREFIX = 'windmill:progress:';

export class ProgressStore {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  // Fold this tree's pre-lane marks into a ProgressLattice and clear them. Stamped by the instant
  // the mark itself recorded, under a `legacy` actor, so the ordering is the truth as this device
  // knew it: a legacy mark genuinely made after a server row still wins, and one the server has
  // since superseded still loses. A mark with no instant at all gets the smallest stamp there is —
  // it loses to everything, which is right, and still lands where nothing contests it.
  //
  // Returns how many registers it moved, so a caller can decide whether the lane needs a flush.
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
      return 0;  // unreadable residue is not worth taking the tree down for
    }
    this.clear(treeId);
    return marks.length;
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
