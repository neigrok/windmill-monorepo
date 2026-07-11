// Routes canvas pointer events to the active tool. Owns pointer capture and the
// single-pointer bookkeeping: the first pointer to go down owns the gesture until
// it comes up; other pointers are ignored mid-gesture. Wheel-zoom is global and
// never goes through a tool. The tool is swappable (setTool) so the editing phase
// can add tools without touching the scene's event plumbing.
export class InputController {
  constructor(canvas, context, tool) {
    this.canvas = canvas;
    this.context = context;
    this.tool = tool;
    this.activePointerId = null;
  }

  setTool(tool) {
    this.tool = tool;
    this.activePointerId = null;
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
    const pos = this.localPos(event);
    const pressed = this.context.pick?.(pos.x, pos.y); // press feedback on the node under the cursor
    if (pressed != null) this.context.press?.(pressed);
    this.canvas.setPointerCapture(event.pointerId);
    this.activePointerId = event.pointerId;
    this.tool.onPointerDown(pos, event);
  };

  onMove = (event) => {
    const pos = this.localPos(event);
    if (this.activePointerId === event.pointerId) this.tool.onPointerDrag(pos, event);
    else if (this.activePointerId === null) this.tool.onPointerMove(pos, event);
  };

  onUp = (event) => {
    if (event.pointerId !== this.activePointerId) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.activePointerId = null;
    this.context.press?.(null); // release: the pressed node springs back
    this.tool.onPointerUp(this.localPos(event), event);
  };

  onLeave = (event) => {
    if (this.activePointerId !== null) return;
    this.tool.onPointerLeave(event);
  };

  onDblClick = (event) => {
    this.tool.onDoubleClick(this.localPos(event), event);
  };

  onWheel = (event) => {
    event.preventDefault();
    this.context.onInteract?.(); // wheel-zoom is a grab too — yield the ceremony
    const pos = this.localPos(event);
    this.context.camera.zoomAt(pos.x, pos.y, event.deltaY);
  };
}
