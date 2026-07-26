// The milestone ledger (share-on-unlock): one localStorage slot per tree remembering which
// milestones have already offered their share — so the pride is offered once ever, even across
// reloads and an undo/re-complete. Keyed by tree id, best-effort like ReturnLedger; a storage
// error is never fatal, it just risks a rare second offer.

const KEY_PREFIX = 'windmill:milestones:';

export class MilestoneLedger {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  // The set of milestone ids this tree has already offered (empty for a tree never finished here).
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
      // storage full or unavailable — best-effort; the offer simply isn't remembered
    }
  }

  // Reset starts the tree over from a blank slate, so its milestones become offerable again —
  // wiped alongside progress, workspace, legend and the return ledger.
  clear(treeId) {
    try {
      this.storage.removeItem(KEY_PREFIX + treeId);
    } catch {
      // ignore
    }
  }
}
