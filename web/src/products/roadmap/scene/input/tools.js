// Pointer tools: the InputController routes canvas pointer events to the active tool, which drives the scene through a small context.

const DRAG_THRESHOLD_PX = 4;
const HOVER_THROTTLE_MS = 40;

export class Tool {
  onPointerDown() {}
  onPointerDrag() {} // the owning pointer moving with the button held
  onPointerMove() {} // a free pointer moving with no button (hover)
  onPointerUp() {} // returns true when the lift became a zoom, so the controller runs no double-tap ladder on top of it
  onPointerLeave() {}
  onPointerCancel() {} // a competing gesture took over — drop any in-progress drag
  onDoubleClick() {}
}

export class NavigateTool extends Tool {
  constructor(context) {
    super();
    this.ctx = context;
    this.drag = null;
    this.lastHoverAt = 0;
  }

  onPointerDown(pos, event, pickedId = this.ctx.pick(pos.x, pos.y, event?.pointerType)) {
    const marquee = !!event?.shiftKey && !!this.ctx.beginMarquee;
    const reorderId = !marquee && this.ctx.beginReorder ? pickedId : null;
    this.drag = { startX: pos.x, startY: pos.y, lastX: pos.x, lastY: pos.y, lastTime: performance.now(), moved: false, vx: 0, vy: 0, marquee, pickedId, reorderId, reordering: false };
    if (marquee) this.ctx.beginMarquee(pos.x, pos.y);
  }

  onPointerDrag(pos) {
    if (!this.drag) return;
    if (this.drag.marquee) {
      if (!this.drag.moved && Math.hypot(pos.x - this.drag.startX, pos.y - this.drag.startY) > DRAG_THRESHOLD_PX) this.drag.moved = true;
      this.ctx.updateMarquee(this.drag.startX, this.drag.startY, pos.x, pos.y);
      return;
    }
    if (this.drag.reorderId) {
      if (!this.drag.moved && Math.hypot(pos.x - this.drag.startX, pos.y - this.drag.startY) > DRAG_THRESHOLD_PX) this.drag.moved = true;
      if (!this.drag.moved) return;
      if (!this.drag.reordering) { this.drag.reordering = true; this.ctx.beginReorder(this.drag.reorderId, pos.x, pos.y); }
      else this.ctx.updateReorder(pos.x, pos.y);
      return;
    }
    const dx = pos.x - this.drag.lastX;
    const dy = pos.y - this.drag.lastY;
    const now = performance.now();
    const dt = Math.max(now - this.drag.lastTime, 1);
    if (!this.drag.moved && Math.hypot(pos.x - this.drag.startX, pos.y - this.drag.startY) > DRAG_THRESHOLD_PX) this.drag.moved = true;
    if (this.drag.moved) { this.ctx.camera.pan(dx, dy); this.ctx.onPan?.(); }
    this.drag.vx = this.drag.vx * 0.7 + (dx / dt) * 0.3;
    this.drag.vy = this.drag.vy * 0.7 + (dy / dt) * 0.3;
    this.drag.lastX = pos.x;
    this.drag.lastY = pos.y;
    this.drag.lastTime = now;
  }

  onPointerMove(pos, event) {
    const now = performance.now();
    if (now - this.lastHoverAt < HOVER_THROTTLE_MS) return;
    this.lastHoverAt = now;
    const id = this.ctx.pick(pos.x, pos.y, event?.pointerType);
    this.ctx.hover(id);
    this.ctx.hoverEdge(id ? null : this.ctx.pickEdge(pos.x, pos.y));
  }

  onPointerUp(pos, event) {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    if (drag.marquee) {
      if (drag.moved) { this.ctx.commitMarquee(drag.startX, drag.startY, pos.x, pos.y, !!event?.shiftKey); return; }
      this.ctx.cancelMarquee();
      const hit = drag.pickedId;
      if (hit) { this.ctx.toggleSelect(hit); return; }
      const edge = this.ctx.pickEdge(pos.x, pos.y);
      if (edge && this.ctx.toggleEdge) this.ctx.toggleEdge(edge);
      return;
    }
    if (drag.reorderId) {
      if (drag.reordering) { this.ctx.commitReorder(pos.x, pos.y); return; }
      this.ctx.select(drag.reorderId); // a press that never lifted is a plain select
      return;
    }
    const { moved, vx, vy } = drag;
    if (moved) { this.ctx.camera.launchInertia(vx, vy); return; }
    const id = drag.pickedId;
    if (id) { this.ctx.select(id); return; }
    if (this.ctx.zoomIntoCrowd(pos.x, pos.y, event?.pointerType)) return true; // too crowded to pick one apart: the tap zooms in instead of missing
    const edge = this.ctx.pickEdge(pos.x, pos.y);
    if (edge) { this.ctx.selectEdge(edge); return; }
    this.ctx.select(null);
  }

  onPointerLeave() {
    this.ctx.hover(null);
    this.ctx.hoverEdge(null);
  }

  onPointerCancel() {
    // Drop any in-flight marquee or reorder, or its preview stays stuck until the next selection change.
    if (this.drag?.marquee) this.ctx.cancelMarquee?.();
    if (this.drag?.reordering) this.ctx.cancelReorder?.();
    this.drag = null;
  }

  onDoubleClick(pos, event) {
    const id = this.ctx.pick(pos.x, pos.y, event?.pointerType);
    if (id) this.ctx.select(id);
  }
}

// The shared-tree viewer: one finger pans 1:1 with no inertia fling, a tap selects, hover is node-only and there is no edge selection.
export class ReadOnlyTool extends NavigateTool {
  onPointerMove(pos, event) {
    const now = performance.now();
    if (now - this.lastHoverAt < HOVER_THROTTLE_MS) return;
    this.lastHoverAt = now;
    this.ctx.hover(this.ctx.pick(pos.x, pos.y, event?.pointerType));
  }

  onPointerUp(pos, event) {
    if (!this.drag) return;
    const { moved, pickedId: id } = this.drag;
    this.drag = null;
    if (moved) return;
    if (id === null && this.ctx.zoomIntoCrowd(pos.x, pos.y, event?.pointerType)) return true;
    if (this.ctx.editTap?.(pos.x, pos.y, id)) return; // an owner editing on a phone routes the picked step by mode
    this.ctx.select(id);
  }

  onDoubleClick() {} // touch double-tap zoom lives in the InputController
}
