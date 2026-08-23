// Pure 2D orthographic camera; world space is Y-down. worldToScreen must stay the exact inverse of screenToWorld or picking drifts.
const MIN_ZOOM = 0.006;
const MAX_ZOOM = 6;
// The touch pinch range; the out-limit must stay below a whole tree's fit zoom (~0.1 on a phone).
const PINCH_MIN_ZOOM = 0.05;
const PINCH_MAX_ZOOM = 2.5;
const PAN_SLACK = 80; // px
const WHEEL_ZOOM_SPEED = 0.0016;
const INERTIA_FRICTION = 3.2;
const INERTIA_STOP_SPEED = 2;
const FOCUS_MIN_ZOOM = 0.6;

// Distance-based glide tiers, seconds.
const GLIDE_SHORT = 0.48;
const GLIDE_DEFAULT = 0.6;
const GLIDE_FAR = 0.72;

const SAFE_FRAME_INSET = 0.1; // central 80% viewport = 10% inset per side
const ZOOM_MATCH_EPSILON = 0.02; // zooms within 2% count as "no change"

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Inside [min,max] the value passes through 1:1; past an edge it eases asymptotically toward at most `slack` beyond, never bouncing back.
function softClamp(value, min, max, slack) {
  if (value < min) return min - slack * (1 - Math.exp((value - min) / slack));
  if (value > max) return max + slack * (1 - Math.exp((max - value) / slack));
  return value;
}

// Cubic-bezier sampler with control points P0=(0,0), P3=(1,1): solves x(t)=x by Newton with a bisection fallback, then evaluates y(t).
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

// Mirrors the --ease-soft CSS token.
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
    this.glide = null;
    this.panBounds = null; // null = free pan
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

  glideTo(x, y, zoom = null) {
    const targetZoom = zoom == null ? Math.max(this.zoom, FOCUS_MIN_ZOOM) : clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    const zoomChanged = Math.abs(targetZoom - this.zoom) > this.zoom * ZOOM_MATCH_EPSILON;
    const viewport = this.getViewport();
    if (!zoomChanged && insideSafeFrame(viewport, x, y)) return;

    this.velocityX = 0;
    this.velocityY = 0;
    const distance = Math.hypot(x - this.x, y - this.y);
    const viewportSpan = Math.min(viewport.maxX - viewport.minX, viewport.maxY - viewport.minY);
    const duration = glideDuration(distance, viewportSpan);
    // from* is the current position, so an in-flight glide bends toward the new target.
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

  // Ease to `targetZoom` with the tapped screen point pinned: the world point is captured once and update() re-derives x/y from it each frame.
  glideZoomAround(pxX, pxY, targetZoom, duration = GLIDE_SHORT) {
    this.velocityX = 0;
    this.velocityY = 0;
    const world = this.screenToWorld(pxX, pxY);
    this.glide = {
      fromZoom: this.zoom,
      toZoom: clamp(targetZoom, MIN_ZOOM, MAX_ZOOM),
      anchor: { px: pxX, py: pxY, wx: world.x, wy: world.y },
      t: 0,
      duration,
    };
    this.dirty = true;
  }

  zoomAt(pxX, pxY, wheelDeltaY) {
    this.zoomAroundPoint(pxX, pxY, Math.exp(-wheelDeltaY * WHEEL_ZOOM_SPEED));
  }

  // Anchored at a screen point and clamped to the touch pinch range; finger-driven, so it never eases.
  zoomAtScale(pxX, pxY, factor) {
    this.glide = null;
    const before = this.screenToWorld(pxX, pxY);
    this.zoom = clamp(this.zoom * factor, PINCH_MIN_ZOOM, PINCH_MAX_ZOOM);
    const after = this.screenToWorld(pxX, pxY);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.dirty = true;
  }

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
    // maxZoom keeps a tiny tree (bounds ~ a point) from fitting-to-fill and ballooning its nodes.
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
      this.zoom = g.fromZoom + (g.toZoom - g.fromZoom) * e;
      if (g.anchor) {
        // Derive the centre from the eased zoom so the anchored world point never drifts.
        this.x = g.anchor.wx - (g.anchor.px - this.viewportWidth / 2) / this.zoom;
        this.y = g.anchor.wy - (g.anchor.py - this.viewportHeight / 2) / this.zoom;
      } else {
        this.x = g.fromX + (g.toX - g.fromX) * e;
        this.y = g.fromY + (g.toY - g.fromY) * e;
      }
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

  // Eased 0..1 settle of the active glide; idle reads 1.
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
