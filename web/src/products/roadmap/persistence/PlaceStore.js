// Where you left off (anon-first-tree F6): one localStorage slot remembering the last
// place the editor stood — tree, camera, selection. The magic-link landing's fresh tab
// reads it to become the old place, and a bare #/app after sign-in lands there too.
// Best-effort like ProgressStore — storage errors are never fatal.

const KEY = 'windmill:last-place';

export class PlaceStore {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  load() {
    try {
      const text = this.storage.getItem(KEY);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  save({ treeId, camera = null, selectedId = null }) {
    try {
      this.storage.setItem(KEY, JSON.stringify({ treeId, camera, selectedId, at: Date.now() }));
    } catch {
      // storage full or unavailable
    }
  }

  forget(treeId) {
    if (this.load()?.treeId !== treeId) return;
    try {
      this.storage.removeItem(KEY);
    } catch {
      // storage unavailable
    }
  }
}
