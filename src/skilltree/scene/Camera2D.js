// Pure 2D orthographic camera: world <-> screen is a scale (zoom) + translate.
// World space is Y-down to match the layout data. The projection here is the
// exact inverse of screenToWorld, so pointer picking stays pixel-accurate.
const MIN_ZOOM = 0.006;
const MAX_ZOOM = 6;
const WHEEL_ZOOM_SPEED = 0.0016;
const INERTIA_FRICTION = 3.2;
const INERTIA_STOP_SPEED = 2;
const FOCUS_MIN_ZOOM = 0.6;
const GLIDE_DURATION = 0.48; // seconds — a calm reveal, matches the spec's ease-soft

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function easeSoft(t) {
  return 1 - Math.pow(1 - t, 3); // ease-out cubic
}

export class Camera2D {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.viewportWidth = 1;
    this.viewportHeight = 1;
    this.velocityX = 0;
    this.velocityY = 0;
    this.glide = null; // an in-flight eased reveal, or null
    this.dirty = true;
  }

  resize(widthPx, heightPx) {
    this.viewportWidth = Math.max(widthPx, 1);
    this.viewportHeight = Math.max(heightPx, 1);
    this.dirty = true;
  }

  screenToWorld(pxX, pxY) {
    return {
      x: this.x + (pxX - this.viewportWidth / 2) / this.zoom,
      y: this.y + (pxY - this.viewportHeight / 2) / this.zoom,
    };
  }

  pan(dxPx, dyPx) {
    this.glide = null;
    this.x -= dxPx / this.zoom;
    this.y -= dyPx / this.zoom;
    this.dirty = true;
  }

  panTo(x, y) {
    this.glide = null;
    this.velocityX = 0;
    this.velocityY = 0;
    this.x = x;
    this.y = y;
    this.dirty = true;
  }

  // Camera-only reveal: an eased glide to a point (used by the activity feed, so a
  // clicked row flies the camera without disturbing selection). Cancels inertia.
  glideTo(x, y, zoom = null) {
    this.velocityX = 0;
    this.velocityY = 0;
    const targetZoom = zoom == null ? Math.max(this.zoom, FOCUS_MIN_ZOOM) : clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.glide = { fromX: this.x, fromY: this.y, fromZoom: this.zoom, toX: x, toY: y, toZoom: targetZoom, t: 0 };
    this.dirty = true;
  }

  zoomAroundPoint(pxX, pxY, factor) {
    this.glide = null;
    const before = this.screenToWorld(pxX, pxY);
    this.zoom = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const after = this.screenToWorld(pxX, pxY);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.dirty = true;
  }

  zoomAt(pxX, pxY, wheelDeltaY) {
    this.zoomAroundPoint(pxX, pxY, Math.exp(-wheelDeltaY * WHEEL_ZOOM_SPEED));
  }

  zoomBy(factor) {
    this.zoomAroundPoint(this.viewportWidth / 2, this.viewportHeight / 2, factor);
  }

  focus(x, y) {
    this.glide = null;
    this.velocityX = 0;
    this.velocityY = 0;
    this.x = x;
    this.y = y;
    if (this.zoom < FOCUS_MIN_ZOOM) this.zoom = FOCUS_MIN_ZOOM;
    this.dirty = true;
  }

  fitToView(bounds, widthPx, heightPx, padding = 0.9) {
    const boundsWidth = Math.max(bounds.maxX - bounds.minX, 1);
    const boundsHeight = Math.max(bounds.maxY - bounds.minY, 1);
    this.glide = null;
    this.velocityX = 0;
    this.velocityY = 0;
    this.zoom = clamp(Math.min(widthPx / boundsWidth, heightPx / boundsHeight) * padding, MIN_ZOOM, MAX_ZOOM);
    this.x = (bounds.minX + bounds.maxX) / 2;
    this.y = (bounds.minY + bounds.maxY) / 2;
    this.dirty = true;
  }

  launchInertia(vxPxPerMs, vyPxPerMs) {
    this.velocityX = (-vxPxPerMs * 1000) / this.zoom;
    this.velocityY = (-vyPxPerMs * 1000) / this.zoom;
  }

  update(dt) {
    if (this.glide) {
      const g = this.glide;
      g.t = Math.min(1, g.t + dt / GLIDE_DURATION);
      const e = easeSoft(g.t);
      this.x = g.fromX + (g.toX - g.fromX) * e;
      this.y = g.fromY + (g.toY - g.fromY) * e;
      this.zoom = g.fromZoom + (g.toZoom - g.fromZoom) * e;
      if (g.t >= 1) this.glide = null;
      this.dirty = false;
      return true;
    }

    const speedSq = this.velocityX * this.velocityX + this.velocityY * this.velocityY;
    if (speedSq > INERTIA_STOP_SPEED * INERTIA_STOP_SPEED) {
      this.x += this.velocityX * dt;
      this.y += this.velocityY * dt;
      const decay = Math.exp(-INERTIA_FRICTION * dt);
      this.velocityX *= decay;
      this.velocityY *= decay;
      this.dirty = true;
    } else {
      this.velocityX = 0;
      this.velocityY = 0;
    }
    const moved = this.dirty;
    this.dirty = false;
    return moved;
  }

  getViewport() {
    const halfW = this.viewportWidth / 2 / this.zoom;
    const halfH = this.viewportHeight / 2 / this.zoom;
    return { minX: this.x - halfW, maxX: this.x + halfW, minY: this.y - halfH, maxY: this.y + halfH };
  }
}
