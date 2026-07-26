// The per-tree, per-device view preferences: which view a tree opens in, which sections it keeps
// folded (X8 L1/L2), and how its progress card names itself (brief #20 — "Week 3" or "Day 17", and
// whether the card carries its ledger). One localStorage slot each, every one a plain
// { [treeId]: value } map. Mirrors PlaceStore — best-effort, storage errors are never fatal, a
// broken slot reads as empty. None of it ever syncs: these are choices about this screen.

import { WEEK_UNIT, DAY_UNIT } from '../share/progressPeriod.js';

const LAST_VIEW_KEY = 'windmill:view:last';
const FOLDED_KEY = 'windmill:view:folded';
const CARD_UNIT_KEY = 'windmill:card:unit';
const CARD_LEDGER_KEY = 'windmill:card:ledger';

export class ViewPrefs {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  lastView(treeId) {
    const view = this.readMap(LAST_VIEW_KEY)[treeId];
    return view === 'list' || view === 'tree' ? view : null;
  }

  setLastView(treeId, view) {
    const map = this.readMap(LAST_VIEW_KEY);
    map[treeId] = view;
    this.writeMap(LAST_VIEW_KEY, map);
  }

  foldedSections(treeId) {
    const folded = this.readMap(FOLDED_KEY)[treeId];
    return Array.isArray(folded) ? folded : [];
  }

  setFoldedSections(treeId, headIds) {
    const map = this.readMap(FOLDED_KEY);
    map[treeId] = headIds;
    this.writeMap(FOLDED_KEY, map);
  }

  // The progress card's period label: weeks by default, days for anyone whose hashtag counts days.
  cardUnit(treeId) {
    return this.readMap(CARD_UNIT_KEY)[treeId] === DAY_UNIT ? DAY_UNIT : WEEK_UNIT;
  }

  setCardUnit(treeId, unit) {
    const map = this.readMap(CARD_UNIT_KEY);
    map[treeId] = unit === DAY_UNIT ? DAY_UNIT : WEEK_UNIT;
    this.writeMap(CARD_UNIT_KEY, map);
  }

  // Whether the card carries its ledger. Default ON: it is the single element that makes a series
  // read as a series. Off is a real choice, though — it publishes the quiet weeks too.
  cardLedger(treeId) {
    return this.readMap(CARD_LEDGER_KEY)[treeId] !== false;
  }

  setCardLedger(treeId, on) {
    const map = this.readMap(CARD_LEDGER_KEY);
    map[treeId] = !!on;
    this.writeMap(CARD_LEDGER_KEY, map);
  }

  readMap(key) {
    try {
      const parsed = JSON.parse(this.storage.getItem(key) ?? 'null');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  writeMap(key, map) {
    try {
      this.storage.setItem(key, JSON.stringify(map));
    } catch {
      // storage full or unavailable
    }
  }
}

// Who lands where (X8 L1): a saved choice wins on return, except an empty tree is always the
// bud canvas (tree) and a tree you just planted opens on the canvas once — birth and arrival
// are canvas ceremonies; the list takes over when you come back to work. With no saved choice,
// the owner comes back to work (list) and a visitor meets the portrait first (tree).
export function initialView({ saved, owner, empty, born = false }) {
  if (born) return 'tree';
  if (empty) return 'tree';
  if (saved === 'list' || saved === 'tree') return saved;
  return owner ? 'list' : 'tree';
}

// The one-shot birth stamp: every planting door (birth canvas, pasted plan, quest) stamps the
// tree it just made; the view decision peeks at it during render (a pure read, safe under
// StrictMode's double-invoke) and clears it from an effect once the decision has landed.
// Session-scoped so it can't leak past the tab, and never fatal — a lost stamp only costs
// the ceremony.
const BORN_KEY = 'windmill:born';

export function stampBorn(treeId, storage = globalThis.sessionStorage) {
  try {
    storage.setItem(BORN_KEY, treeId);
  } catch {
    // no session storage — the tree just opens on the owner's default view
  }
}

export function peekBorn(treeId, storage = globalThis.sessionStorage) {
  try {
    return storage.getItem(BORN_KEY) === treeId;
  } catch {
    return false;
  }
}

export function clearBorn(treeId, storage = globalThis.sessionStorage) {
  try {
    if (storage.getItem(BORN_KEY) === treeId) storage.removeItem(BORN_KEY);
  } catch {
    // nothing to clear
  }
}
