// Pointer tools: each interprets the same gesture stream differently. The
// InputController routes canvas pointer events to the active tool, which reads
// and drives the scene through a small context (camera, pick, pickEdge,
// select, selectEdge, hover, hoverEdge). Wheel-zoom is global and never goes
// through a tool.
//
// NavigateTool is the viewer behaviour and the editing default: drag to pan;
// hover highlights a node or deepens a branch (never chrome — spec v2 §1.1,
// §4.1); a click selects a node, else a branch, else clears.

const DRAG_THRESHOLD_PX = 4;
const HOVER_THROTTLE_MS = 40;

export class Tool {
  onPointerDown() {}
  onPointerDrag() {} // the owning pointer moving with the button held
  onPointerMove() {} // a free pointer moving with no button (hover)
  onPointerUp() {}
  onPointerLeave() {}
  onPointerCancel() {} // a competing gesture (a pinch) took over — drop any in-progress drag
  onDoubleClick() {}
}

export class NavigateTool extends Tool {
  constructor(context) {
    super();
    this.ctx = context;
    this.drag = null;
    this.lastHoverAt = 0;
  }

  onPointerDown(pos, event) {
    // Shift+press starts a marquee (rubber-band select) instead of a pan — but only in the
    // editor, where the scene wired the marquee hooks. Read-only keeps shift-drag a plain pan.
    const marquee = !!event?.shiftKey && !!this.ctx.beginMarquee;
    this.drag = { startX: pos.x, startY: pos.y, lastX: pos.x, lastY: pos.y, lastTime: performance.now(), moved: false, vx: 0, vy: 0, marquee };
    if (marquee) this.ctx.beginMarquee(pos.x, pos.y);
  }

  onPointerDrag(pos) {
    if (!this.drag) return;
    if (this.drag.marquee) { // rubber-band: grow the band, never pan or gather inertia
      if (!this.drag.moved && Math.hypot(pos.x - this.drag.startX, pos.y - this.drag.startY) > DRAG_THRESHOLD_PX) this.drag.moved = true;
      this.ctx.updateMarquee(this.drag.startX, this.drag.startY, pos.x, pos.y);
      return;
    }
    const dx = pos.x - this.drag.lastX;
    const dy = pos.y - this.drag.lastY;
    const now = performance.now();
    const dt = Math.max(now - this.drag.lastTime, 1);
    if (!this.drag.moved && Math.hypot(pos.x - this.drag.startX, pos.y - this.drag.startY) > DRAG_THRESHOLD_PX) this.drag.moved = true;
    if (this.drag.moved) { this.ctx.camera.pan(dx, dy); this.ctx.onPan?.(); } // signal the pan so the shell can fade its chrome
    this.drag.vx = this.drag.vx * 0.7 + (dx / dt) * 0.3;
    this.drag.vy = this.drag.vy * 0.7 + (dy / dt) * 0.3;
    this.drag.lastX = pos.x;
    this.drag.lastY = pos.y;
    this.drag.lastTime = now;
  }

  onPointerMove(pos) {
    const now = performance.now();
    if (now - this.lastHoverAt < HOVER_THROTTLE_MS) return;
    this.lastHoverAt = now;
    const id = this.ctx.pick(pos.x, pos.y);
    this.ctx.hover(id);
    this.ctx.hoverEdge(id ? null : this.ctx.pickEdge(pos.x, pos.y)); // deepen a branch only off-node
  }

  onPointerUp(pos, event) {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    if (drag.marquee) {
      if (drag.moved) { this.ctx.commitMarquee(drag.startX, drag.startY, pos.x, pos.y, !!event?.shiftKey); return; }
      this.ctx.cancelMarquee(); // a shift-click that never dragged: no band to keep — just toggle the node
      const hit = this.ctx.pick(pos.x, pos.y);
      if (hit) this.ctx.toggleSelect(hit);
      return;
    }
    const { moved, vx, vy } = drag;
    if (moved) { this.ctx.camera.launchInertia(vx, vy); return; }
    const id = this.ctx.pick(pos.x, pos.y);
    if (id) { this.ctx.select(id); return; }
    const edge = this.ctx.pickEdge(pos.x, pos.y);
    if (edge) { this.ctx.selectEdge(edge); return; }
    this.ctx.select(null);
  }

  onPointerLeave() {
    this.ctx.hover(null);
    this.ctx.hoverEdge(null);
  }

  onPointerCancel() {
    this.drag = null;
  }

  onDoubleClick(pos) {
    const id = this.ctx.pick(pos.x, pos.y);
    if (id) this.ctx.select(id);
  }
}

// ReadOnlyTool is the shared-tree viewer: one finger pans (it never grabs a node), a
// tap selects the node under it (else clears), and there's no inertia fling and no edge
// selection — the pan stays a strict 1:1 finger drive so the camera's soft-clamp at the
// tree bounds reads cleanly. Hover is node-only (a touch device emits no free-pointer
// moves, so there's no hover on phones; a desktop ?view still gets a light highlight).
export class ReadOnlyTool extends NavigateTool {
  onPointerMove(pos) {
    const now = performance.now();
    if (now - this.lastHoverAt < HOVER_THROTTLE_MS) return;
    this.lastHoverAt = now;
    this.ctx.hover(this.ctx.pick(pos.x, pos.y));
  }

  onPointerUp(pos) {
    if (!this.drag) return;
    const moved = this.drag.moved;
    this.drag = null;
    if (moved) return; // a pan settles in place — no fling
    this.ctx.select(this.ctx.pick(pos.x, pos.y)); // a tap selects the node under it, else clears
  }

  onDoubleClick() {} // touch double-tap zoom lives in the InputController; no node-select here
}
