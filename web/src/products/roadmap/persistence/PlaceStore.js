// The last place the editor stood — tree, camera, selection. Storage errors are never fatal.

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
    }
  }

  forget(treeId) {
    if (this.load()?.treeId !== treeId) return;
    try {
      this.storage.removeItem(KEY);
    } catch {
    }
  }
}
