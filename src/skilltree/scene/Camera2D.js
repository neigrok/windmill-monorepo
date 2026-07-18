// Pure 2D orthographic camera: world <-> screen is a scale (zoom) + translate.
// World space is Y-down to match the layout data. The projection here is the
// exact inverse of screenToWorld, so pointer picking stays pixel-accurate.
const MIN_ZOOM = 0.006;
const MAX_ZOOM = 6;
const PINCH_MIN_ZOOM = 0.5; // the touch pinch range (§S3) — tighter than the wheel's
const PINCH_MAX_ZOOM = 2.5;
const PAN_SLACK = 80; // px the read-only pan may drift past the tree bounds before it stalls
const WHEEL_ZOOM_SPEED = 0.0016;
const INERTIA_FRICTION = 3.2;
const INERTIA_STOP_SPEED = 2;
const FOCUS_MIN_ZOOM = 0.6;

// Distance-based glide tiers (seconds) — canonical motion spec §6: 600ms default,
// 480ms for near targets, 720ms cap for far ones.
const GLIDE_SHORT = 0.48;
const GLIDE_DEFAULT = 0.6;
const GLIDE_FAR = 0.72;

const SAFE_FRAME_INSET = 0.1; // central 80% viewport = 10% inset per side
const ZOOM_MATCH_EPSILON = 0.02; // zooms within 2% count as "no change"

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Soft boundary: inside [min,max] the value passes through 1:1; past an edge it eases
// toward at most `slack` beyond, asymptotically — a heavier world near the clamp with
// no rubber-band bounce (the derivative is 1 at the edge, tapering to 0 far outside).
function softClamp(value, min, max, slack) {
  if (value < min) return min - slack * (1 - Math.exp((value - min) / slack));
  if (value > max) return max + slack * (1 - Math.exp((max - value) / slack));
  return value;
}

// Cubic-bezier sampler for a CSS timing token: solves x(t)=x by Newton (bisection
// fallback), then evaluates y(t). Control points are P0=(0,0), P3=(1,1).
function cubicBezier(x1, y1, x2, y2) {
  const ax = 1 - 3 * x2 + 3 * x1;
  const bx = 3 * x2 - 6 * x1;
  const cx = 3 * x1;
  const ay = 1 - 3 * y2 + 3 * y1;
  const by = 3 * y2 - 6 * y1;
  const cy = 3 * y1;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return sampleY(t);
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    let mid = x;
    for (let i = 0; i < 24; i++) {
      const err = sampleX(mid) - x;
      if (Math.abs(err) < 1e-6) return sampleY(mid);
      if (err > 0) hi = mid;
      else lo = mid;
      mid = (lo + hi) / 2;
    }
    return sampleY(mid);
  };
}

// --ease-soft = cubic-bezier(0.16, 1, 0.3, 1) — the calm-reveal curve. Built once.
const easeSoft = cubicBezier(0.16, 1, 0.3, 1);

function glideDuration(distance, viewportSpan) {
  if (distance <= viewportSpan / 2) return GLIDE_SHORT;
  if (distance >= viewportSpan) return GLIDE_FAR;
  return GLIDE_DEFAULT;
}

function insideSafeFrame(viewport, x, y) {
  const insetX = (viewport.maxX - viewport.minX) * SAFE_FRAME_INSET;
  const insetY = (viewport.maxY - viewport.minY) * SAFE_FRAME_INSET;
  return (
    x >= viewport.minX + insetX &&
    x <= viewport.maxX - insetX &&
    y >= viewport.minY + insetY &&
    y <= viewport.maxY - insetY
  );
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
    this.panBounds = null; // read-only soft-clamp bounds, or null for free pan
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

  worldToScreen(wx, wy) {
    return {
      x: (wx - this.x) * this.zoom + this.viewportWidth / 2,
      y: (wy - this.y) * this.zoom + this.viewportHeight / 2,
    };
  }

  pan(dxPx, dyPx) {
    this.glide = null;
    const x = this.x - dxPx / this.zoom;
    const y = this.y - dyPx / this.zoom;
    if (this.panBounds) {
      const slack = PAN_SLACK / this.zoom;
      this.x = softClamp(x, this.panBounds.minX, this.panBounds.maxX, slack);
      this.y = softClamp(y, this.panBounds.minY, this.panBounds.maxY, slack);
    } else {
      this.x = x;
      this.y = y;
    }
    this.dirty = true;
  }

  // Read-only touch pan is soft-clamped to the tree: pass the model bounds here and
  // pan() lets the camera drift at most PAN_SLACK px past them, the world getting
  // heavier the further out (never bouncing back). Null restores the free editor pan.
  setPanBounds(bounds) {
    this.panBounds = bounds;
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
    const targetZoom = zoom == null ? Math.max(this.zoom, FOCUS_MIN_ZOOM) : clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    const zoomChanged = Math.abs(targetZoom - this.zoom) > this.zoom * ZOOM_MATCH_EPSILON;
    const viewport = this.getViewport();
    // Safe-frame gate: target already in the central 80% and no material zoom change
    // means the user is already looking at it — do nothing.
    if (!zoomChanged && insideSafeFrame(viewport, x, y)) return;

    this.velocityX = 0;
    this.velocityY = 0;
    const distance = Math.hypot(x - this.x, y - this.y);
    const viewportSpan = Math.min(viewport.maxX - viewport.minX, viewport.maxY - viewport.minY);
    const duration = glideDuration(distance, viewportSpan);
    // Retarget-live: fromX/Y/Zoom are the current position, so an in-flight glide
    // bends toward the new target continuously (t resets, inertia stays zeroed).
    this.glide = { fromX: this.x, fromY: this.y, fromZoom: this.zoom, toX: x, toY: y, toZoom: targetZoom, t: 0, duration };
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

  // Pinch zoom: multiply the zoom by `factor` (the live finger-spread ratio) anchored
  // at a screen point, clamped to the touch range. Mirrors zoomAt but takes a factor
  // instead of a wheel delta; finger-driven, so it never eases.
  zoomAtScale(pxX, pxY, factor) {
    this.glide = null;
    const before = this.screenToWorld(pxX, pxY);
    this.zoom = clamp(this.zoom * factor, PINCH_MIN_ZOOM, PINCH_MAX_ZOOM);
    const after = this.screenToWorld(pxX, pxY);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.dirty = true;
  }

  // A fresh grab cancels any in-flight glide/inertia in place — the finger takes over
  // at once (the user always wins). Halts the tween without moving the camera.
  stopMotion() {
    this.glide = null;
    this.velocityX = 0;
    this.velocityY = 0;
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

  // Rehydrate a saved viewpoint (PlaceStore): a teleport, no glide — the tab opens
  // already standing where the last one stood.
  restore(x, y, zoom) {
    this.glide = null;
    this.velocityX = 0;
    this.velocityY = 0;
    this.x = x;
    this.y = y;
    this.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.dirty = true;
  }

  fitToView(bounds, widthPx, heightPx, padding = 0.9, maxZoom = MAX_ZOOM) {
    const boundsWidth = Math.max(bounds.maxX - bounds.minX, 1);
    const boundsHeight = Math.max(bounds.maxY - bounds.minY, 1);
    this.glide = null;
    this.velocityX = 0;
    this.velocityY = 0;
    // A tiny tree (bounds ~ a point) would otherwise fit-to-fill and balloon its nodes; maxZoom
    // caps that so a near-empty tree opens at a natural node size. Big trees fit well below it.
    this.zoom = clamp(Math.min(widthPx / boundsWidth, heightPx / boundsHeight) * padding, MIN_ZOOM, maxZoom);
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
      g.t = Math.min(1, g.t + dt / g.duration);
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

  isGliding() {
    return this.glide != null;
  }

  // Eased 0..1 settle of the active glide (idle = 1, fully settled). The ceremony
  // orchestrator starts dependent beats once this crosses DEPEND_AT (0.90).
  settleProgress() {
    if (!this.glide) return 1;
    return easeSoft(this.glide.t);
  }

  getViewport() {
    const halfW = this.viewportWidth / 2 / this.zoom;
    const halfH = this.viewportHeight / 2 / this.zoom;
    return { minX: this.x - halfW, maxX: this.x + halfW, minY: this.y - halfH, maxY: this.y + halfH };
  }
}
