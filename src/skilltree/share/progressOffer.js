// When to offer the progress card, and when to shut up (design brief #20). A recurring offer is
// only worth having if it can't become nagging, so this is a pure decision over two facts — the
// share ledger's baseline, and when we last asked — and the caller does the rest.
//
// The shape is considerAutoOpen's (ui/NextUp.jsx), the house's only other recurring offer, because
// its split is the good part: the budget is NOT burned at decision time. `commit()` stamps the
// cooldown, and the caller invokes it at the moment the toast actually fires — so an offer that
// loses the lane to a milestone, or dies on a mid-flight demotion, costs nothing.

import { ShareLedger } from '../persistence/ShareLedger.js';

const OFFER_KEY_PREFIX = 'windmill:shareoffer:';

const MIN_NEW = 3;                                    // a post worth making has a few steps in it
const STALE_MS = 7 * 24 * 60 * 60 * 1000;             // …unless it's been a week, when one will do
const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;          // and we ask at most this often, ever

// → { offer: false } | { offer: true, lit: string[], update: number, commit: () => void }
export function considerProgressShare({ treeId, completed, states, now = Date.now(), storage = window.localStorage }) {
  // Never shared this tree: there is no baseline to be "since", and the first share belongs to the
  // link/milestone path, not to a card about a diff.
  const prior = new ShareLedger(storage).load(treeId);
  if (!prior) return { offer: false };

  let lastOfferAt = null;
  try { lastOfferAt = JSON.parse(storage.getItem(OFFER_KEY_PREFIX + treeId))?.lastOfferAt ?? null; } catch { lastOfferAt = null; }
  if (lastOfferAt !== null && now - lastOfferAt < COOLDOWN_MS) return { offer: false };

  const lit = ShareLedger.since(completed, prior, states);
  if (lit.length === 0) return { offer: false };
  const overdue = now - (prior.at ?? 0) >= STALE_MS;
  if (lit.length < MIN_NEW && !overdue) return { offer: false };

  return {
    offer: true,
    lit,
    update: (prior.count ?? 0) + 1,
    commit: () => {
      // best-effort, never fatal — a storage error at worst risks one extra offer later
      try { storage.setItem(OFFER_KEY_PREFIX + treeId, JSON.stringify({ lastOfferAt: now })); } catch {}
    },
  };
}
