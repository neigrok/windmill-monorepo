// Routes canvas pointer events to the active tool; the first pointer down owns the gesture until it lifts, others are ignored mid-gesture. Two touch fingers pinch; wheel and double-tap zoom never go through a tool.

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_TOL = 32; // screen px
const TAP_MOVE_TOL = 10; // screen px
const LONG_PRESS_MS = 500;
const DOUBLE_TAP_ZOOM_IN = 1.6;
const DOUBLE_TAP_ZOOM_OUT = 1;
const DOUBLE_TAP_PIVOT = 1.3; // below -> step in, at/above -> step out
const DOUBLE_TAP_STEP = 2; // far out: each tap steps in by this factor, capped at the out-level

export class InputController {
  constructor(canvas, context, tool) {
    this.canvas = canvas;
    this.context = context;
    this.tool = tool;
    this.activePointerId = null;
    this.touches = new Map(); // pointerId -> screen pos, kept to 2
    this.pinch = null; // { lastDist, lastMid }
    this.downPos = null;
    this.downTime = 0;
    this.lastTap = null; // { x, y, time }
    this.longPressTimer = null;
    this.longPressFired = false;
  }

  setTool(tool) {
    clearTimeout(this.longPressTimer);
    this.longPressFired = false;
    this.tool = tool;
    this.activePointerId = null;
    this.touches.clear();
    this.pinch = null;
  }

  bind() {
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onUp);
    this.canvas.addEventListener('pointerleave', this.onLeave);
    this.canvas.addEventListener('dblclick', this.onDblClick);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  unbind() {
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.canvas.removeEventListener('dblclick', this.onDblClick);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  localPos(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  onDown = (event) => {
    this.context.onInteract?.();
    if (event.pointerType === 'touch') this.context.camera.stopMotion?.();
    const pos = this.localPos(event);

    if (event.pointerType === 'touch') {
      if (this.touches.size >= 2) return;
      this.touches.set(event.pointerId, pos);
      if (this.touches.size === 2) { this.beginPinch(event.pointerId); return; }
    }

    const pressed = this.context.pick?.(pos.x, pos.y);
    if (pressed != null) this.context.press?.(pressed);
    this.canvas.setPointerCapture(event.pointerId);
    this.activePointerId = event.pointerId;
    this.downPos = pos;
    this.downTime = performance.now();
    this.tool.onPointerDown(pos, event);
    // onLongPress returns true iff it armed multi-select; onUp then swallows the lift so the gesture never also taps.
    this.longPressFired = false;
    if (event.pointerType === 'touch' && this.context.onLongPress && pressed != null) {
      this.longPressTimer = setTimeout(() => { this.longPressFired = this.context.onLongPress(pressed) === true; }, LONG_PRESS_MS);
    }
  };

  onMove = (event) => {
    const pos = this.localPos(event);
    if (this.touches.has(event.pointerId)) this.touches.set(event.pointerId, pos);
    if (this.pinch) { this.updatePinch(); return; }
    if (this.activePointerId === event.pointerId) {
      if (this.downPos && Math.hypot(pos.x - this.downPos.x, pos.y - this.downPos.y) > TAP_MOVE_TOL) clearTimeout(this.longPressTimer);
      this.tool.onPointerDrag(pos, event);
    } else if (this.activePointerId === null) this.tool.onPointerMove(pos, event);
  };

  onUp = (event) => {
    const wasTouch = event.pointerType === 'touch';
    if (this.touches.has(event.pointerId)) this.touches.delete(event.pointerId);

    if (this.pinch) {
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      if (this.touches.size < 2) this.pinch = null;
      return;
    }

    if (event.pointerId !== this.activePointerId) return;
    clearTimeout(this.longPressTimer);
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.activePointerId = null;
    this.context.press?.(null);
    if (this.longPressFired) { this.longPressFired = false; return; } // the long-press consumed this gesture
    const pos = this.localPos(event);
    this.tool.onPointerUp(pos, event);
    if (wasTouch) this.detectDoubleTap(pos);
  };

  onLeave = (event) => {
    if (this.activePointerId !== null || this.pinch) return;
    this.tool.onPointerLeave(event);
  };

  onDblClick = (event) => {
    this.tool.onDoubleClick(this.localPos(event), event);
  };

  onWheel = (event) => {
    event.preventDefault();
    this.context.onInteract?.();
    const pos = this.localPos(event);
    this.context.camera.zoomAt(pos.x, pos.y, event.deltaY);
  };

  // A second finger abandons the first finger’s gesture and tracks the spread + midpoint.
  beginPinch(pointerId) {
    clearTimeout(this.longPressTimer); // a second finger is a pinch, not a hold
    this.longPressFired = false;
    if (this.activePointerId !== null) {
      this.tool.onPointerCancel();
      this.context.press?.(null);
      this.activePointerId = null;
    }
    this.canvas.setPointerCapture(pointerId);
    const [a, b] = [...this.touches.values()];
    this.pinch = { lastDist: distance(a, b), lastMid: midpoint(a, b) };
  }

  updatePinch() {
    if (this.touches.size < 2) return;
    const [a, b] = [...this.touches.values()];
    const dist = distance(a, b);
    const mid = midpoint(a, b);
    this.context.camera.pan(mid.x - this.pinch.lastMid.x, mid.y - this.pinch.lastMid.y);
    if (dist > 0 && this.pinch.lastDist > 0) this.context.camera.zoomAtScale(mid.x, mid.y, dist / this.pinch.lastDist);
    this.context.onPan?.();
    this.pinch.lastDist = dist;
    this.pinch.lastMid = mid;
  }

  detectDoubleTap(pos) {
    if (this.downPos == null || Math.hypot(pos.x - this.downPos.x, pos.y - this.downPos.y) > TAP_MOVE_TOL) { this.lastTap = null; return; }
    const now = performance.now();
    if (this.lastTap && now - this.lastTap.time < DOUBLE_TAP_MS && Math.hypot(pos.x - this.lastTap.x, pos.y - this.lastTap.y) < DOUBLE_TAP_TOL) {
      const zoom = this.context.camera.zoom;
      // Below the out-level, step one notch in, capped there; above it, toggle around the pivot.
      const target = zoom < DOUBLE_TAP_ZOOM_OUT
        ? Math.min(zoom * DOUBLE_TAP_STEP, DOUBLE_TAP_ZOOM_OUT)
        : zoom < DOUBLE_TAP_PIVOT ? DOUBLE_TAP_ZOOM_IN : DOUBLE_TAP_ZOOM_OUT;
      this.context.camera.glideZoomAround(pos.x, pos.y, target);
      this.lastTap = null;
      return;
    }
    this.lastTap = { x: pos.x, y: pos.y, time: now };
  }
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
