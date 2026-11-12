// Per-tree, per-device view preferences. One localStorage slot each, a { [treeId]: value } map;
// a broken slot reads as empty. None of it syncs.

import { localStorageOrNothing, sessionStorageOrNothing } from './browserStorage.js';

const LAST_VIEW_KEY = 'windmill:view:last';
const VIEWS = ['list', 'board', 'tree'];
const WRITTEN_VIEWS = ['board', 'tree'];

export class ViewPrefs {
  constructor(storage = localStorageOrNothing()) {
    this.storage = storage;
  }

  lastView(treeId) {
    const view = this.readMap(LAST_VIEW_KEY)[treeId];
    return VIEWS.includes(view) ? view : null;
  }

  setLastView(treeId, view) {
    if (!WRITTEN_VIEWS.includes(view)) return;
    const map = this.readMap(LAST_VIEW_KEY);
    map[treeId] = view;
    this.writeMap(LAST_VIEW_KEY, map);
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

// Without the Graph every visit opens the Board; otherwise birth, empty, the view a tree visit carried, linked, reader
// and saved choices decide. `carried` is { view, door } from going into a tree through a step, or coming back from one.
export function initialView({ saved, owner, reader = false, empty, born = false, carried = null, linkedStep = null, canAddFirstStep = false, graphAvailable = true }) {
  if (!graphAvailable) {
    const decision = initialView({ saved, owner, reader, empty, born, carried, linkedStep, canAddFirstStep });
    return decision.view === 'tree' ? { view: 'board', door: 'no_graph' } : decision;
  }
  if (owner && empty && canAddFirstStep) return { view: 'board', door: 'empty' };
  if (born) return { view: 'tree', door: 'born' };
  if (empty) return { view: 'tree', door: 'empty' };
  if (carried?.view) return { view: carried.view, door: carried.door };
  if (linkedStep !== null) return { view: 'board', door: 'link' };
  if (reader) return { view: 'tree', door: 'default' };
  if (saved === 'tree') return { view: 'tree', door: 'saved' };
  if (saved === 'list' || saved === 'board') return { view: 'board', door: 'saved' };
  return { view: owner ? 'board' : 'tree', door: 'default' };
}

// The Board shows while its roadmap loads or fails to load, and once loaded unless it crashed; a roadmap with no steps
// shows there only where the Board's New step can plant the first one.
export function boardCanShow({ crashed = false, loaded = false, empty = false, canAddFirstStep = false }) {
  if (crashed) return false;
  if (!loaded || !empty) return true;
  return canAddFirstStep;
}

// Without the Graph the Board stays present, including its crash screen; otherwise unavailable Boards show the Graph.
export function viewToShow(view, board, graphAvailable = true) {
  if (!graphAvailable) return 'board';
  return view === 'board' && !boardCanShow(board) ? 'tree' : view;
}

// Session-scoped one-shot birth stamp: a planting door stamps the tree it made, the view decision
// peeks and clears it.
const BORN_KEY = 'windmill:born';
// Session-scoped one-shot notes a planting door leaves for what it planted to say on its first open.
const PLANTED_QUEST_KEY = 'windmill:planted-quest';
const FORKED_KEY = 'windmill:forked-from-demo';

function leaveNote(key, storage) {
  try {
    storage.setItem(key, '1');
  } catch {
  }
}

function takeNote(key, storage) {
  try {
    if (storage.getItem(key) !== '1') return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function notePlantedQuest(storage = sessionStorageOrNothing()) {
  leaveNote(PLANTED_QUEST_KEY, storage);
}

export function noteForked(storage = sessionStorageOrNothing()) {
  leaveNote(FORKED_KEY, storage);
}

export function takePlantNote(storage = sessionStorageOrNothing()) {
  return { quest: takeNote(PLANTED_QUEST_KEY, storage), forked: takeNote(FORKED_KEY, storage) };
}

export function stampBorn(treeId, storage = sessionStorageOrNothing()) {
  try {
    storage.setItem(BORN_KEY, treeId);
  } catch {
  }
}

export function peekBorn(treeId, storage = sessionStorageOrNothing()) {
  try {
    return storage.getItem(BORN_KEY) === treeId;
  } catch {
    return false;
  }
}

export function clearBorn(treeId, storage = sessionStorageOrNothing()) {
  try {
    if (storage.getItem(BORN_KEY) === treeId) storage.removeItem(BORN_KEY);
  } catch {
  }
}
