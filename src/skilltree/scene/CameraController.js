// Owns camera motion only — no DOM listeners of its own. SkillTreeScene binds
// pointer/wheel events (it needs the same coordinates for picking) and calls in
// through this small, explicit set of verbs. World space is Y-down, matching the
// layout data: top/bottom are swapped on the frustum once, here, so every other
// coordinate in the scene (node offsets, connector points, pointer math) can stay
// in plain data space with no further sign-flipping.
const MIN_ZOOM = 0.006;
const MAX_ZOOM = 6;
const CAMERA_DISTANCE = 1000;
const WHEEL_ZOOM_SPEED = 0.0016;
const INERTIA_FRICTION = 3.2; // higher = stops sooner
const INERTIA_STOP_SPEED = 2; // world units/sec, below this we snap to a stop
const FOCUS_MIN_ZOOM = 0.6;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class CameraController {
  constructor(camera) {
    this.camera = camera;
    this.camera.position.z = CAMERA_DISTANCE;
    this.camera.near = 1;
    this.camera.far = 2000;
    this.camera.zoom = 1;

    this.viewportWidth = 1;
    this.viewportHeight = 1;
    this.velocityX = 0;
    this.velocityY = 0;
    this.dirty = true;
  }

  resize(widthPx, heightPx) {
    this.viewportWidth = Math.max(widthPx, 1);
    this.viewportHeight = Math.max(heightPx, 1);
    this.camera.left = -this.viewportWidth / 2;
    this.camera.right = this.viewportWidth / 2;
    // Swapped (not the conventional +h/2, -h/2): flips world Y so increasing
    // data-space Y renders lower on screen, matching the layout's TB convention.
    this.camera.top = -this.viewportHeight / 2;
    this.camera.bottom = this.viewportHeight / 2;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  screenToWorld(pxX, pxY) {
    return {
      x: this.camera.position.x + (pxX - this.viewportWidth / 2) / this.camera.zoom,
      y: this.camera.position.y + (pxY - this.viewportHeight / 2) / this.camera.zoom,
    };
  }

  pan(dxPx, dyPx) {
    this.camera.position.x -= dxPx / this.camera.zoom;
    this.camera.position.y -= dyPx / this.camera.zoom;
    this.dirty = true;
  }

  panTo(x, y) {
    this.velocityX = 0;
    this.velocityY = 0;
    this.camera.position.x = x;
    this.camera.position.y = y;
    this.dirty = true;
  }

  zoomAroundPoint(pxX, pxY, factor) {
    const before = this.screenToWorld(pxX, pxY);
    this.camera.zoom = clamp(this.camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    this.camera.updateProjectionMatrix();

    const after = this.screenToWorld(pxX, pxY);
    this.camera.position.x += before.x - after.x;
    this.camera.position.y += before.y - after.y;
    this.dirty = true;
  }

  zoomAt(pxX, pxY, wheelDeltaY) {
    this.zoomAroundPoint(pxX, pxY, Math.exp(-wheelDeltaY * WHEEL_ZOOM_SPEED));
  }

  zoomBy(factor) {
    this.zoomAroundPoint(this.viewportWidth / 2, this.viewportHeight / 2, factor);
  }

  focus(x, y) {
    this.velocityX = 0;
    this.velocityY = 0;
    this.camera.position.x = x;
    this.camera.position.y = y;
    if (this.camera.zoom < FOCUS_MIN_ZOOM) {
      this.camera.zoom = FOCUS_MIN_ZOOM;
      this.camera.updateProjectionMatrix();
    }
    this.dirty = true;
  }

  fitToView(bounds, widthPx, heightPx, padding = 0.9) {
    const boundsWidth = Math.max(bounds.maxX - bounds.minX, 1);
    const boundsHeight = Math.max(bounds.maxY - bounds.minY, 1);
    const zoom = Math.min(widthPx / boundsWidth, heightPx / boundsHeight) * padding;

    this.velocityX = 0;
    this.velocityY = 0;
    this.camera.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.camera.updateProjectionMatrix();
    this.camera.position.x = (bounds.minX + bounds.maxX) / 2;
    this.camera.position.y = (bounds.minY + bounds.maxY) / 2;
    this.dirty = true;
  }

  launchInertia(vxPxPerMs, vyPxPerMs) {
    this.velocityX = (-vxPxPerMs * 1000) / this.camera.zoom;
    this.velocityY = (-vyPxPerMs * 1000) / this.camera.zoom;
  }

  update(dt) {
    const speedSq = this.velocityX * this.velocityX + this.velocityY * this.velocityY;
    if (speedSq > INERTIA_STOP_SPEED * INERTIA_STOP_SPEED) {
      this.camera.position.x += this.velocityX * dt;
      this.camera.position.y += this.velocityY * dt;
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
    const halfW = this.viewportWidth / 2 / this.camera.zoom;
    const halfH = this.viewportHeight / 2 / this.camera.zoom;
    return {
      minX: this.camera.position.x - halfW,
      maxX: this.camera.position.x + halfW,
      minY: this.camera.position.y - halfH,
      maxY: this.camera.position.y + halfH,
    };
  }
}
