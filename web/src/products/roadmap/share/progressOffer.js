// When the week's card is worth offering, and when the offer retires for good. It rides the return:
// the first open after a period closes, once per period, never mid-session, never on the first
// period. Two declines in a row retire it for that tree, permanently and silently; an offer counts
// as declined the moment it is made (commit()), and taking it clears the count (accept()). A
// surface with no other door to the same card passes `countsAsDecline: false`.

import { ShareLedger } from '../persistence/ShareLedger.js';
import { ProgressPeriod, newThisPeriod } from './progressPeriod.js';

const OFFER_KEY_PREFIX = 'windmill:shareoffer:';
const DECLINES_TO_RETIRE = 2;

// → { offer: false } | { offer: true, period, lit, sinceAt, commit, accept }
export function considerProgressShare({ treeId, plantedAt = 0, completed, states, completedAt = {}, unit, now = Date.now(), storage = window.localStorage }) {
  const slot = loadSlot(storage, treeId);
  if (slot.declines >= DECLINES_TO_RETIRE) return { offer: false };
  // No planting time, no clock: nothing can say a period closed.
  if (plantedAt <= 0) return { offer: false };

  // Never shared this tree: there is no baseline to be "since".
  const prior = new ShareLedger(storage).load(treeId);
  if (!prior) return { offer: false };

  const period = new ProgressPeriod({ plantedAt, now, unit, ordinal: (prior.count ?? 0) + 1 });
  if (period.index < 2) return { offer: false };              // never on the first period
  if (slot.period === period.index) return { offer: false };  // and never twice within one

  const { lit, sinceAt } = newThisPeriod({ completed, states, completedAt, prior, period });
  if (lit.length === 0) return { offer: false };              // a quiet period is never offered

  return {
    offer: true,
    period,
    lit,
    sinceAt,
    commit: ({ countsAsDecline = true } = {}) => saveSlot(storage, treeId, {
      period: period.index,
      declines: slot.declines + (countsAsDecline ? 1 : 0),
    }),
    accept: () => saveSlot(storage, treeId, { period: period.index, declines: 0 }),
  };
}

// A storage that refuses reads as a fresh, un-retired tree.
function loadSlot(storage, treeId) {
  try {
    const slot = JSON.parse(storage.getItem(OFFER_KEY_PREFIX + treeId) ?? 'null');
    return { period: slot?.period ?? 0, declines: slot?.declines ?? 0 };
  } catch {
    return { period: 0, declines: 0 };
  }
}

function saveSlot(storage, treeId, slot) {
  try {
    storage.setItem(OFFER_KEY_PREFIX + treeId, JSON.stringify(slot));
  } catch {
  }
}
