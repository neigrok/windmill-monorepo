// Routes canvas pointer events to the active tool. Owns pointer capture and the
// single-pointer bookkeeping: the first pointer to go down owns the gesture until it
// comes up; other pointers are ignored mid-gesture. Two touch fingers instead drive a
// pinch (zoom + two-finger pan) handled here, never through a tool, and a touch
// double-tap steps the zoom. Wheel-zoom is global too. The tool is swappable (setTool)
// so the editing phase can add tools without touching the scene's event plumbing.

const DOUBLE_TAP_MS = 300; // two taps within this window count as a double-tap
const DOUBLE_TAP_TOL = 32; // ...and within this many screen px of each other
const TAP_MOVE_TOL = 10; // a tap barely moves; further than this is a drag, not a tap
const DOUBLE_TAP_ZOOM_IN = 1.6; // double-tap steps between these two zooms
const DOUBLE_TAP_ZOOM_OUT = 1;
const DOUBLE_TAP_PIVOT = 1.3; // below → step in, at/above → step out

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
  }

  setTool(tool) {
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
  };

  onMove = (event) => {
    const pos = this.localPos(event);
    if (this.touches.has(event.pointerId)) this.touches.set(event.pointerId, pos);
    if (this.pinch) { this.updatePinch(); return; }
    if (this.activePointerId === event.pointerId) this.tool.onPointerDrag(pos, event);
    else if (this.activePointerId === null) this.tool.onPointerMove(pos, event);
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
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.activePointerId = null;
    this.context.press?.(null); // release: the pressed node springs back
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
      const world = this.context.camera.screenToWorld(pos.x, pos.y);
      const target = this.context.camera.zoom < DOUBLE_TAP_PIVOT ? DOUBLE_TAP_ZOOM_IN : DOUBLE_TAP_ZOOM_OUT;
      this.context.camera.glideTo(world.x, world.y, target);
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
