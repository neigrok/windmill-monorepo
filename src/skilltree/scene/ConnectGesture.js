// Dragging a connection from a node's rim port to another node (design editing-spec
// §03). A dashed ghost branch follows the cursor; the node under it gets an olive
// ring when it's a valid target, or a brick ring + "would create a loop" tip when
// dropping there would make a cycle (the source's ancestors). Cycles are shown —
// and blocked — before the drop; releasing on a valid target fires onConnect, on
// anything else it just retracts.
import { NODE_SIZE } from '../theme.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const NODE_RADIUS = NODE_SIZE * 0.42;

export class ConnectGesture {
  constructor(canvas, container, { camera, pick, onConnect }) {
    this.canvas = canvas;
    this.camera = camera;
    this.pick = pick;
    this.onConnect = onConnect;
    this.nodesById = new Map();
    this.parents = new Map();
    this.active = null;

    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.setAttribute('class', 'st-connect');
    this.path = document.createElementNS(SVGNS, 'path');
    this.path.setAttribute('class', 'st-connect-ghost');
    this.svg.appendChild(this.path);
    container.appendChild(this.svg);

    this.ring = document.createElement('div');
    this.ring.className = 'st-connect-ring';
    container.appendChild(this.ring);

    this.tip = document.createElement('div');
    this.tip.className = 'st-connect-tip';
    this.tip.textContent = 'This would create a loop';
    container.appendChild(this.tip);
  }

  setModel(nodesById, parents) {
    this.nodesById = nodesById;
    this.parents = parents;
  }

  start(sourceId, event) {
    if (!sourceId || !this.nodesById.has(sourceId)) return;
    event.stopPropagation();
    this.captureEl = event.target;
    this.captureEl.setPointerCapture(event.pointerId);
    this.captureEl.addEventListener('pointermove', this.onMove);
    this.captureEl.addEventListener('pointerup', this.onUp);
    this.active = { sourceId, pointerId: event.pointerId, targetId: null, ancestors: this.ancestorsOf(sourceId) };
    this.svg.classList.add('st-connect--on');
    this.onMove(event);
  }

  onMove = (event) => {
    if (!this.active || event.pointerId !== this.active.pointerId) return;
    const cam = this.camera;
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const source = this.nodesById.get(this.active.sourceId);
    const sx = (source.x - cam.x) * cam.zoom + cam.viewportWidth / 2;
    const sy = (source.y - cam.y) * cam.zoom + cam.viewportHeight / 2;

    const hit = this.pick(px, py);
    const cyclic = hit && this.active.ancestors.has(hit);
    const valid = hit && hit !== this.active.sourceId && !cyclic && !(this.parents.get(hit) || []).includes(this.active.sourceId);

    let ex = px;
    let ey = py;
    if (hit) {
      const node = this.nodesById.get(hit);
      ex = (node.x - cam.x) * cam.zoom + cam.viewportWidth / 2;
      ey = (node.y - cam.y) * cam.zoom + cam.viewportHeight / 2;
      const rim = NODE_RADIUS * cam.zoom;
      this.showRing(ex, ey, rim, valid ? 'valid' : 'invalid');
      if (cyclic) this.showTip(ex, ey, rim); else this.hideTip();
    } else {
      this.hideRing();
      this.hideTip();
    }
    this.active.targetId = valid ? hit : null;
    this.path.setAttribute('d', this.curve(sx, sy, ex, ey));
  };

  onUp = (event) => {
    if (!this.active || event.pointerId !== this.active.pointerId) return;
    if (this.captureEl.hasPointerCapture(event.pointerId)) this.captureEl.releasePointerCapture(event.pointerId);
    this.captureEl.removeEventListener('pointermove', this.onMove);
    this.captureEl.removeEventListener('pointerup', this.onUp);
    const { sourceId, targetId } = this.active;
    this.active = null;
    this.svg.classList.remove('st-connect--on');
    this.hideRing();
    this.hideTip();
    if (targetId && this.onConnect) this.onConnect(sourceId, targetId);
  };

  ancestorsOf(id) {
    const seen = new Set();
    const stack = [...(this.parents.get(id) || [])];
    while (stack.length > 0) {
      const parent = stack.pop();
      if (seen.has(parent)) continue;
      seen.add(parent);
      stack.push(...(this.parents.get(parent) || []));
    }
    return seen;
  }

  curve(sx, sy, ex, ey) {
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy) || 1;
    const bend = 0.09 * len;
    const cx = (sx + ex) / 2 - (dy / len) * bend;
    const cy = (sy + ey) / 2 + (dx / len) * bend;
    return `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`;
  }

  showRing(x, y, rim, kind) {
    const diameter = (rim + 7) * 2;
    this.ring.className = `st-connect-ring st-connect-ring--${kind} st-connect-ring--on`;
    this.ring.style.width = `${diameter}px`;
    this.ring.style.height = `${diameter}px`;
    this.ring.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  }

  hideRing() { this.ring.classList.remove('st-connect-ring--on'); }

  showTip(x, y, rim) {
    this.tip.classList.add('st-connect-tip--on');
    this.tip.style.transform = `translate(${x}px, ${y + rim + 12}px) translate(-50%, 0)`;
  }

  hideTip() { this.tip.classList.remove('st-connect-tip--on'); }
}
