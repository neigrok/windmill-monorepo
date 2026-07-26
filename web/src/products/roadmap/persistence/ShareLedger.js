// The share ledger (brief #20 — the repeat-share surface): one localStorage slot per tree
// remembering the completed set that was on screen the last time this user actually SHARED,
// when that was, which share it was, and a short HISTORY of what the cards before it claimed.
// The progress card's "since you last shared" is the diff against this slot and nothing else.
//
// It looks like ReturnLedger and is deliberately not it. ReturnLedger re-baselines on every
// completion — it answers "what has this device not yet witnessed", so its diff collapses to
// empty the instant you finish a step yourself. This one is written ONLY when a share happens,
// which is the whole reason it is a separate file: a baseline that survives your own work is
// the only honest way to say "since you last shared" without per-node server timestamps.
//
// The history exists for the card's ledger row. It records what each POSTED CARD stamped, so the
// row can be rebuilt from published claims rather than from local clocks — see ledgerDeltas in
// share/progressPeriod.js for why that distinction is the whole point.
//
// Best-effort like every store here — a storage error degrades to "never shared", never throws.

const KEY_PREFIX = 'windmill:shared:';
const HISTORY_LIMIT = 12; // covers the ledger's six-period window even for someone posting twice a week

export class ShareLedger {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  // The last share's slot, or null for a tree this user has never shared.
  load(treeId) {
    try {
      const text = this.storage.getItem(KEY_PREFIX + treeId);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  // `count` is the share ordinal — 1 for the first share ever. It names the card ("Update #N") only
  // when the tree carries no planting time to count weeks from. The caller advances it; the ledger
  // just remembers. `at` is when that card was posted: the period it covered is counted from it, so
  // a skipped period can be named on the next card's sub-line.
  //
  // `delta` is what this card STAMPED — the week card knows its own, and states it, so the ledger
  // row on every later card agrees with the one the user already published. Anything else (a link
  // share, which carries no weekly claim) falls back to the set difference, which is the same
  // statement made from the same facts.
  save(treeId, { completed, at, count, delta = null }) {
    try {
      const prior = this.load(treeId);
      const posted = { at, delta: delta ?? ShareLedger.newCount(completed, prior) };
      const history = [...(prior?.history ?? []), posted].slice(-HISTORY_LIMIT);
      this.storage.setItem(KEY_PREFIX + treeId, JSON.stringify({ completed: [...completed], at, count, history }));
    } catch {
      // storage full or unavailable — the ledger is best-effort, never fatal
    }
  }

  clear(treeId) {
    try {
      this.storage.removeItem(KEY_PREFIX + treeId);
    } catch {
      // ignore
    }
  }

  // The ids complete now that the last share didn't carry — the steps the progress card lights.
  // A pure set-diff, never a clock: it stays true for someone who posts fortnightly and it
  // catches work done on another device, which carries no local timestamp at all. Filtered to
  // nodes the tree still holds, so a completion whose node was since deleted can't be claimed.
  // Never shared (a null slot) returns nothing — the first share is not a diff.
  static since(currentCompletedSet, prior, statesMap) {
    if (!prior) return [];
    const shared = new Set(prior.completed ?? []);
    const since = [];
    for (const id of currentCompletedSet) {
      if (shared.has(id)) continue;
      if (!statesMap.has(id)) continue;
      since.push(id);
    }
    return since;
  }

  // How many of these completions the last posted card didn't carry — what a card posted right now
  // would stamp. The same set-diff as `since`, without a tree to filter against, for the history
  // entry a share writes about itself. A tree with no earlier card has nothing to be a delta FROM,
  // so it counts 0 rather than claiming a whole history as one period's work.
  static newCount(completed, prior) {
    if (!prior) return 0;
    const shared = new Set(prior.completed ?? []);
    let fresh = 0;
    for (const id of completed) if (!shared.has(id)) fresh += 1;
    return fresh;
  }
}
