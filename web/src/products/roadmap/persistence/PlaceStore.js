// The last place the editor stood — tree, camera, selection. Storage errors are never fatal.

const KEY = 'windmill:last-place';
const CAMERA_LAYOUT = 'organic-radial-v3';

export class PlaceStore {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  load() {
    try {
      const text = this.storage.getItem(KEY);
      if (!text) return null;
      const place = JSON.parse(text);
      if (!place || typeof place !== 'object') return null;
      if (place.cameraLayout !== CAMERA_LAYOUT) return { ...place, camera: null };
      return place;
    } catch {
      return null;
    }
  }

  save({ treeId, camera = null, selectedId = null }) {
    try {
      this.storage.setItem(KEY, JSON.stringify({ treeId, camera, selectedId, cameraLayout: CAMERA_LAYOUT, at: Date.now() }));
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
