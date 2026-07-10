// Branch-hover chrome (editing-spec §04–§05): hovering a branch shows a midpoint
// × to delete it (endpoint handles for reconnect land here next). A scene overlay
// (plain DOM + callbacks, like AffordanceLayer) repositioned per frame. The × is
// offset perpendicular from the path so the branch stays visible under the cursor.
import { NODE_SIZE } from '../theme.js';

const CROSS_OFFSET = 13; // screen px the × sits off the branch midpoint
const GRACE_MS = 220;

export class EdgeChrome {
  constructor(canvas, { onDeleteEdge } = {}) {
    this.onDeleteEdge = onDeleteEdge;
    this.container = document.createElement('div');
    this.container.className = 'st-edgechrome';
    canvas.parentElement.appendChild(this.container);

    this.cross = document.createElement('button');
    this.cross.className = 'st-edge-x';
    this.cross.textContent = '×';
    this.cross.addEventListener('pointerenter', () => this.keepAlive());
    this.cross.addEventListener('pointerleave', () => this.scheduleHide());
    this.cross.addEventListener('click', () => { if (this.edge && this.onDeleteEdge) this.onDeleteEdge(this.edge.from, this.edge.to); this.clear(); });
    this.container.appendChild(this.cross);

    this.nodesById = new Map();
    this.edge = null;
    this.hideTimer = null;
  }

  setModel(renderModel) {
    this.nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    this.clear();
  }

  setHoveredEdge(edge) {
    if (edge && this.nodesById.has(edge.from) && this.nodesById.has(edge.to)) {
      this.edge = edge;
      this.keepAlive();
      this.container.classList.add('st-edgechrome--on');
    } else {
      this.scheduleHide();
    }
  }

  keepAlive() {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
  }

  scheduleHide() {
    this.keepAlive();
    this.hideTimer = setTimeout(() => this.clear(), GRACE_MS);
  }

  clear() {
    this.keepAlive();
    this.edge = null;
    this.container.classList.remove('st-edgechrome--on');
  }

  update(camera) {
    if (!this.edge) return;
    const from = this.nodesById.get(this.edge.from);
    const to = this.nodesById.get(this.edge.to);
    const fx = (from.x - camera.x) * camera.zoom + camera.viewportWidth / 2;
    const fy = (from.y - camera.y) * camera.zoom + camera.viewportHeight / 2;
    const tx = (to.x - camera.x) * camera.zoom + camera.viewportWidth / 2;
    const ty = (to.y - camera.y) * camera.zoom + camera.viewportHeight / 2;
    const mx = (fx + tx) / 2;
    const my = (fy + ty) / 2;
    const len = Math.hypot(tx - fx, ty - fy) || 1;
    const nx = -(ty - fy) / len;
    const ny = (tx - fx) / len;
    this.cross.style.transform = `translate(${mx + nx * CROSS_OFFSET}px, ${my + ny * CROSS_OFFSET}px) translate(-50%, -50%)`;
  }

  dispose() {
    this.container.remove();
  }
}
