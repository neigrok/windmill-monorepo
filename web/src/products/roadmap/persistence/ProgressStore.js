// LEGACY RESIDUE, kept only so the device sweep can wipe it. Progress lives in the private lane of
// the SyncStore blob now (sync/progressLattice.js), and nothing reads these keys any more — but
// they are still sitting in real browsers from before the lane, holding one account's marks in a
// place the account hand-off has to reach. `treeIds` + `clear` are the whole surface the sweep in
// sync/localTrees.js uses; `load` and `save` are gone with the reader that wanted them.
//
// Delete this file once the sweep has plausibly run everywhere.
const KEY_PREFIX = 'windmill:progress:';

export class ProgressStore {
  constructor(storage = window.localStorage) {
    this.storage = storage;
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
