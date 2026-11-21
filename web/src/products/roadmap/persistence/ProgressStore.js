// Reads the localStorage progress keys that browsers still hold; nothing writes them. `drainInto`
// moves residue into the SyncStore private lane and clears the key; the carry-over (roadmap-on-the-engine.md §8.2)
// carries what is left into the replica.
// TODO: delete this file once the drain has plausibly run everywhere.

import { reportInvalidProgressMark, reportRoadmapFailure } from '../reportFailure.js';
import { localStorageOrNothing } from './browserStorage.js';

const KEY_PREFIX = 'windmill:progress:';

export class ProgressStore {
  constructor(storage = localStorageOrNothing(), { reportFailure = reportRoadmapFailure } = {}) {
    this.storage = storage;
    this.reportFailure = reportFailure;
  }

  // What a tree's key holds, or null where it holds nothing that reads.
  load(treeId) {
    try {
      const text = this.storage.getItem(KEY_PREFIX + treeId);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  // The marks a key held: each completed step complete and each step begun and not completed none, stamped by the
  // instant it recorded under a `legacy` actor; a mark with no instant gets the smallest stamp and loses to everything.
  static marksOf(saved) {
    const completed = saved?.completed ?? [];
    return [
      ...completed.map((id) => ({ node: id, status: 'complete', at: `${saved.completedAt?.[id] ?? 1}:0:legacy` })),
      ...(saved?.inProgress ?? []).filter((id) => !completed.includes(id)).map((id) => ({ node: id, status: 'none', at: `${saved.startedAt?.[id] ?? 1}:0:legacy` })),
    ];
  }

  // Returns how many registers it moved.
  drainInto(treeId, lattice, onInvalidMark = () => reportInvalidProgressMark(this.reportFailure)) {
    const saved = this.load(treeId);
    if (!saved) return 0;
    const marks = ProgressStore.marksOf(saved);
    let skipped = 0;
    try {
      lattice.join({ marks }, () => {
        skipped += 1;
        onInvalidMark();
      });
    } catch {
      return 0;
    }
    this.clear(treeId);
    return marks.length - skipped;
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

  // The carry-over's delete: the key goes only while it still holds `seen`, as `load` read it. Answers whether it went.
  clearIfStill(treeId, seen) {
    try {
      if (this.storage.getItem(KEY_PREFIX + treeId) !== JSON.stringify(seen)) return false;
      this.storage.removeItem(KEY_PREFIX + treeId);
      return this.storage.getItem(KEY_PREFIX + treeId) === null;
    } catch {
      return false;
    }
  }
}
