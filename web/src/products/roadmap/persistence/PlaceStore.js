// The last place the editor stood — tree, camera, selection. A camera means nothing under another layout, so a place
// carries the engine's name and the camera format; a mismatch hands back no camera. Storage errors are never fatal.

const KEY = 'windmill:last-place';
// Bumped by hand whenever the camera's meaning changes — the working-zoom frame, or an engine's geometry.
const CAMERA_FORMAT = 'bubble-168-1';

export class PlaceStore {
  constructor(storage = window.localStorage) {
    this.storage = storage;
  }

  load(layout) {
    try {
      const text = this.storage.getItem(KEY);
      if (!text) return null;
      const place = JSON.parse(text);
      if (!place || typeof place !== 'object') return null;
      if (place.layout !== layout || place.cameraFormat !== CAMERA_FORMAT) return { ...place, camera: null };
      return place;
    } catch {
      return null;
    }
  }

  save({ treeId, layout, camera = null, selectedId = null }) {
    try {
      this.storage.setItem(KEY, JSON.stringify({ treeId, layout, cameraFormat: CAMERA_FORMAT, camera, selectedId, at: Date.now() }));
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
