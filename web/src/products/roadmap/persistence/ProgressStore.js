// Reads the localStorage progress keys that browsers still hold; nothing writes them. `drainInto`
// moves residue into the SyncStore private lane and clears the key.
// TODO: delete this file once the drain has plausibly run everywhere.

import { reportInvalidProgressMark, reportRoadmapFailure } from '../reportFailure.js';
import { localStorageOrNothing } from './browserStorage.js';

const KEY_PREFIX = 'windmill:progress:';

export class ProgressStore {
  constructor(storage = localStorageOrNothing(), { reportFailure = reportRoadmapFailure } = {}) {
    this.storage = storage;
    this.reportFailure = reportFailure;
  }

  // Marks are stamped by the instant they recorded, under a `legacy` actor; a mark with no
  // instant gets the smallest stamp and loses to everything. Returns how many registers it moved.
  drainInto(treeId, lattice, onInvalidMark = () => reportInvalidProgressMark(this.reportFailure)) {
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
      if ((saved.completed ?? []).includes(id)) continue;
      marks.push({ node: id, status: 'none', at: `${saved.startedAt?.[id] ?? 1}:0:legacy` });
    }
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
}
