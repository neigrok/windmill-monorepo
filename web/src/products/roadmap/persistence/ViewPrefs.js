// Per-tree, per-device view preferences. One localStorage slot each, a { [treeId]: value } map;
// a broken slot reads as empty. None of it syncs.

const LAST_VIEW_KEY = 'windmill:view:last';
const VIEWS = ['list', 'board', 'tree'];
const FOLDED_KEY = 'windmill:view:folded';

export class ViewPrefs {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  lastView(treeId) {
    const view = this.readMap(LAST_VIEW_KEY)[treeId];
    return VIEWS.includes(view) ? view : null;
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
    }
  }
}

// Empty or just planted opens the canvas, then a saved choice wins, then owners work and visitors look; the Board, while open, is the List's stand-in.
export function initialView({ saved, owner, empty, born = false, boardOpen = false }) {
  const working = boardOpen ? 'board' : 'list';
  if (born) return 'tree';
  if (empty) return 'tree';
  if (saved === 'tree') return 'tree';
  if (saved === 'list' || saved === 'board') return working;
  return owner ? working : 'tree';
}

// Session-scoped one-shot birth stamp: a planting door stamps the tree it made, the view decision
// peeks and clears it.
const BORN_KEY = 'windmill:born';

export function stampBorn(treeId, storage = globalThis.sessionStorage) {
  try {
    storage.setItem(BORN_KEY, treeId);
  } catch {
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
  }
}
