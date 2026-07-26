// Routes canvas pointer events to the active tool. Owns pointer capture and the
// single-pointer bookkeeping: the first pointer to go down owns the gesture until it
// comes up; other pointers are ignored mid-gesture. Two touch fingers instead drive a
// pinch (zoom + two-finger pan) handled here, never through a tool, and a touch
// double-tap steps the zoom. Wheel-zoom is global too. The tool is swappable (setTool)
// so the editing phase can add tools without touching the scene's event plumbing.

const DOUBLE_TAP_MS = 300; // two taps within this window count as a double-tap
const DOUBLE_TAP_TOL = 32; // ...and within this many screen px of each other
const TAP_MOVE_TOL = 10; // a tap barely moves; further than this is a drag, not a tap
const LONG_PRESS_MS = 500; // a still finger held this long over a node enters multi-select (M5)
const DOUBLE_TAP_ZOOM_IN = 1.6; // the settled toggle steps between these two zooms
const DOUBLE_TAP_ZOOM_OUT = 1; // ...and this out-level is also where the far-out walk-in hands off
const DOUBLE_TAP_PIVOT = 1.3; // within the toggle: below → step in, at/above → step out
const DOUBLE_TAP_STEP = 2; // far out (a whole-tree fit sits near 0.1 on a phone): each tap eases forward by this factor, never past the out-level

export class InputController {
  constructor(canvas, context, tool) {
    this.canvas = canvas;
    this.context = context;
    this.tool = tool;
    this.activePointerId = null;
    this.touches = new Map(); // live touch pointers → screen pos, for pinch (kept to 2)
    this.pinch = null; // { lastDist, lastMid } while two fingers are down
    this.downPos = null; // where the single-pointer gesture began (tap detection)
    this.downTime = 0;
    this.lastTap = null; // the previous tap { x, y, time } for double-tap
    this.longPressTimer = null; // pending hold → multi-select (M5): armed in onDown, cleared on pan/lift/pinch
    this.longPressFired = false; // the hold fired — the lift that ends it must not also tap/select
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
    this.context.onInteract?.(); // the user grabs — any live ceremony fast-forwards
    if (event.pointerType === 'touch') this.context.camera.stopMotion?.(); // the user wins: cancel any tween
    const pos = this.localPos(event);

    if (event.pointerType === 'touch') {
      if (this.touches.size >= 2) return; // a third finger is ignored
      this.touches.set(event.pointerId, pos);
      if (this.touches.size === 2) { this.beginPinch(event.pointerId); return; }
    }

    const pressed = this.context.pick?.(pos.x, pos.y); // press feedback on the node under the cursor
    if (pressed != null) this.context.press?.(pressed);
    this.canvas.setPointerCapture(event.pointerId);
    this.activePointerId = event.pointerId;
    this.downPos = pos;
    this.downTime = performance.now();
    this.tool.onPointerDown(pos, event);
    // Long-press over a node arms multi-select (M5): a finger held still past LONG_PRESS_MS fires
    // once. A pan cancels it (onMove) and the lift it consumes is swallowed (onUp), so the same
    // gesture never also taps. Only over a node — pressed is a real id — and only for this single
    // active pointer (a pinch returned above). onLongPress returns true iff it armed multi-select
    // (mirrors editTap's consume); on desktop / a read-only share it returns false, so nothing swallows.
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
      // A pan wins the moment the finger travels past the tap tolerance — the deliberate-entry
      // rule (M5): the hold arms multi-select only if the finger stays put for the full hold.
      if (this.downPos && Math.hypot(pos.x - this.downPos.x, pos.y - this.downPos.y) > TAP_MOVE_TOL) clearTimeout(this.longPressTimer);
      this.tool.onPointerDrag(pos, event);
    } else if (this.activePointerId === null) this.tool.onPointerMove(pos, event);
  };

  onUp = (event) => {
    const wasTouch = event.pointerType === 'touch';
    if (this.touches.has(event.pointerId)) this.touches.delete(event.pointerId);

    if (this.pinch) { // a pinch finger lifted
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      if (this.touches.size < 2) this.pinch = null; // ...the pinch ends only once back under two fingers
      return;
    }

    if (event.pointerId !== this.activePointerId) return;
    clearTimeout(this.longPressTimer); // the hold is over either way — cancel any pending fire
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.activePointerId = null;
    this.context.press?.(null); // release: the pressed node springs back
    if (this.longPressFired) { this.longPressFired = false; return; } // the long-press consumed this gesture — no tap/select on lift
    const pos = this.localPos(event);
    this.tool.onPointerUp(pos, event);
    if (wasTouch) this.detectDoubleTap(pos);
  };

  onLeave = (event) => {
    if (this.activePointerId !== null || this.pinch) return;
    this.tool.onPointerLeave(event);
  };

  onDblClick = (event) => {
    this.tool.onDoubleClick(this.localPos(event), event); // desktop keeps its dblclick behaviour
  };

  onWheel = (event) => {
    event.preventDefault();
    this.context.onInteract?.(); // wheel-zoom is a grab too — yield the ceremony
    const pos = this.localPos(event);
    this.context.camera.zoomAt(pos.x, pos.y, event.deltaY);
  };

  // A second finger went down: abandon the first finger's single-pointer gesture (no
  // select, no move) and start tracking the pinch from the current spread + midpoint.
  beginPinch(pointerId) {
    clearTimeout(this.longPressTimer); // a second finger is a pinch, not a hold — disarm multi-select
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

  // Each pinch move: two-finger pan by the midpoint drift, then zoom by the change in
  // finger spread anchored at that midpoint. Finger-driven — no easing, exempt from
  // the motion ceilings.
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

  // A second still tap on ~the same spot within the window steps the zoom at the tap
  // point (reusing the camera's eased glide). A tap that moved is a pan, not a tap.
  detectDoubleTap(pos) {
    if (this.downPos == null || Math.hypot(pos.x - this.downPos.x, pos.y - this.downPos.y) > TAP_MOVE_TOL) { this.lastTap = null; return; }
    const now = performance.now();
    if (this.lastTap && now - this.lastTap.time < DOUBLE_TAP_MS && Math.hypot(pos.x - this.lastTap.x, pos.y - this.lastTap.y) < DOUBLE_TAP_TOL) {
      const zoom = this.context.camera.zoom;
      // Far out (a whole-tree fit): ease forward one step, capped at the out-level, so repeated taps
      // walk in gently instead of lunging straight to the in-level. From the out-level up it's the
      // default toggle — below the pivot steps in, at/above steps out.
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
