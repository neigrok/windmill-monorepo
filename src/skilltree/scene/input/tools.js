// Pointer tools: each interprets the same gesture stream differently. The
// InputController routes canvas pointer events to the active tool, which reads
// and drives the scene through a small context (camera, pick, pickEdge, getNode,
// select, selectEdge, hover, hoverEdge, moveNode). Wheel-zoom is global and
// never goes through a tool.
//
// NavigateTool is the viewer behaviour: drag to pan; hover highlights a node or
// deepens a branch (never chrome — spec v2 §1.1, §4.1); a click selects a node,
// else a branch, else clears. MoveTool adds node dragging — press on a node
// drags it, press on empty space falls back to NavigateTool's pan.

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

  onPointerDown(pos) {
    this.drag = { startX: pos.x, startY: pos.y, lastX: pos.x, lastY: pos.y, lastTime: performance.now(), moved: false, vx: 0, vy: 0 };
  }

  onPointerDrag(pos) {
    if (!this.drag) return;
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

  onPointerUp(pos) {
    if (!this.drag) return;
    const { moved, vx, vy } = this.drag;
    this.drag = null;
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

export class MoveTool extends NavigateTool {
  constructor(context) {
    super(context);
    this.node = null;
    this.grabX = 0;
    this.grabY = 0;
    this.startX = 0;
    this.startY = 0;
    this.moved = false;
  }

  onPointerDown(pos, event) {
    const id = this.ctx.pick(pos.x, pos.y);
    if (id) {
      const node = this.ctx.getNode(id);
      const world = this.ctx.camera.screenToWorld(pos.x, pos.y);
      this.node = id;
      this.grabX = node.x - world.x;
      this.grabY = node.y - world.y;
      this.startX = pos.x;
      this.startY = pos.y;
      this.moved = false;
      this.ctx.select(id);
      return;
    }
    super.onPointerDown(pos, event);
  }

  onPointerDrag(pos, event) {
    if (this.node) {
      if (!this.moved && Math.hypot(pos.x - this.startX, pos.y - this.startY) > DRAG_THRESHOLD_PX) this.moved = true;
      if (this.moved) {
        const world = this.ctx.camera.screenToWorld(pos.x, pos.y);
        this.ctx.moveNode(this.node, world.x + this.grabX, world.y + this.grabY);
      }
      return;
    }
    super.onPointerDrag(pos, event);
  }

  onPointerUp(pos, event) {
    if (this.node) {
      const id = this.node;
      const moved = this.moved;
      this.node = null;
      if (moved) this.ctx.endMove(id); // a real drag — record it; a click just selected
      return;
    }
    super.onPointerUp(pos, event);
  }

  onPointerCancel() {
    this.node = null;
    super.onPointerCancel();
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
