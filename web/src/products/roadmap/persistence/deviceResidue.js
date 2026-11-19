// What a browser keeps of the roadmaps a person opened beside their records: each roadmap's legend, its return ledger of
// the steps completed since the last visit and its milestone ledger, the last place and what sharing left. An explicit
// sign-out, an account replacement and an account closure forget what sharing left and every roadmap's but the anonymous
// ones, which stay with whoever is at the browser next; a sign-in's Discard forgets the roadmaps it took.

import { LegendStore } from './LegendStore.js';
import { MilestoneLedger } from './MilestoneLedger.js';
import { PlaceStore } from './PlaceStore.js';
import { ReturnLedger } from './ReturnLedger.js';
import { localStorageOrNothing } from './browserStorage.js';

const SHARE_RESIDUE = (key) => key.startsWith('windmill:shared:') || key === 'windmill:card:unit' || key === 'windmill:card:ledger';

// What sharing left: the shared links and the share card's unit and ledger.
export function forgetShareResidue() {
  try {
    const storage = localStorageOrNothing();
    const keys = Array.from({ length: storage.length ?? 0 }, (_, index) => storage.key(index));
    for (const key of keys) if (key && SHARE_RESIDUE(key)) storage.removeItem(key);
  } catch { /* storage refused holds nothing */ }
}

// What the browser kept of each roadmap `goes` says went: its legend, both ledgers, and the last place where it stood on one.
export function forgetTreeResidue(goes) {
  for (const PerTreeStore of [LegendStore, ReturnLedger, MilestoneLedger]) {
    const perTree = new PerTreeStore();
    for (const treeId of perTree.treeIds()) if (goes(treeId)) perTree.clear(treeId);
  }
  const place = new PlaceStore();
  const stood = place.load()?.treeId;
  if (stood && goes(stood)) place.forget(stood);
}
