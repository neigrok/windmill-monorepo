// When the week's card is worth offering — and when the offer has to retire for good.
//
// The offer used to ride a completion on a three-day budget. It rides the RETURN now: the first
// open after a period closes, on the tail of the welcome-back recap, once per period and never
// twice. That is what lets a recurring beat exist without becoming nagging — it is pinned to a
// rhythm the user can feel (their own planting anniversary, every seven days) instead of to a
// counter that meters asks. Never mid-session, never on a timer, never on the first period.
//
// TWO DECLINES IN A ROW RETIRE IT FOR THAT TREE — permanently, silently, no confirmation. A decline
// needs no button to press: an offer counts as declined the moment it is MADE (commit()), and
// taking it clears the count (accept()). A toast that faded, a tab that closed, a week ignored —
// all the same answer, and two of them in a row mean this person does not post. Nothing is lost by
// being wrong: the share menu keeps the same card behind "Share the week", so the offer is only
// ever an accelerator, never the only door.
//
// That last sentence is the RULE'S PRECONDITION, not decoration — retiring the offer is only safe
// while another door exists. `commit({ countsAsDecline })` is where the caller vouches for one.
// A surface with no share menu (today: the phone chrome) still spends the period's one ask, but
// never counts it, because there a fading toast is not a refusal — it is the only door closing.
//
// The shape is considerAutoOpen's (ui/NextUp.jsx): the decision is free, and the caller burns the
// budget at the moment the toast actually fires — so an offer that loses the lane to a milestone
// costs nothing and comes back next period.

import { ShareLedger } from '../persistence/ShareLedger.js';
import { ProgressPeriod, newThisPeriod } from './progressPeriod.js';

const OFFER_KEY_PREFIX = 'windmill:shareoffer:';
const DECLINES_TO_RETIRE = 2;

// → { offer: false } | { offer: true, period, lit, sinceAt, commit, accept }
export function considerProgressShare({ treeId, plantedAt = 0, completed, states, completedAt = {}, unit, now = Date.now(), storage = window.localStorage }) {
  const slot = loadSlot(storage, treeId);
  if (slot.declines >= DECLINES_TO_RETIRE) return { offer: false };
  // No planting time, no clock: we cannot know a period closed, and a card that guessed would be
  // guessing about the one number it prints biggest. The share menu still opens the same card.
  if (plantedAt <= 0) return { offer: false };

  // Never shared this tree: there is no baseline to be "since", and the first share belongs to the
  // link/milestone path, not to a card about a diff.
  const prior = new ShareLedger(storage).load(treeId);
  if (!prior) return { offer: false };

  const period = new ProgressPeriod({ plantedAt, now, unit, ordinal: (prior.count ?? 0) + 1 });
  if (period.index < 2) return { offer: false };              // never on the first period
  if (slot.period === period.index) return { offer: false };  // and never twice within one

  const { lit, sinceAt } = newThisPeriod({ completed, states, completedAt, prior, period });
  if (lit.length === 0) return { offer: false };              // a quiet period is never dressed up as a post

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

// Best-effort like every store here — a storage that refuses reads as a fresh, un-retired tree,
// which at worst costs one extra ask later.
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
    // storage full or unavailable
  }
}
