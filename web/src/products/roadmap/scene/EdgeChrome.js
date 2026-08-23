// Chrome for the selected branch: a midpoint × to delete it and a handle at each end to re-aim it.
import { NODE_SIZE } from '../theme.js';

const NODE_RADIUS = NODE_SIZE * 0.42;
const CROSS_OFFSET = 13; // screen px the × sits off the branch midpoint
const HANDLE_GAP = 4; // screen px a handle sits beyond the node rim, along the branch

export class EdgeChrome {
  constructor(canvas, { onDeleteEdge, onReconnectStart } = {}) {
    this.onDeleteEdge = onDeleteEdge;
    this.onReconnectStart = onReconnectStart;
    this.container = document.createElement('div');
    this.container.className = 'st-edgechrome';
    canvas.parentElement.appendChild(this.container);

    this.cross = document.createElement('button');
    this.cross.className = 'st-edge-x';
    this.cross.textContent = '×';
    this.cross.addEventListener('click', () => { if (this.edge && this.onDeleteEdge) this.onDeleteEdge(this.edge.from, this.edge.to); });
    this.container.appendChild(this.cross);

    this.handles = ['from', 'to'].map((end) => {
      const handle = document.createElement('div');
      handle.className = 'st-edge-handle';
      handle.addEventListener('pointerdown', (event) => this.beginReconnect(end, event));
      this.container.appendChild(handle);
      return handle;
    });

    this.nodesById = new Map();
    this.edge = null;
  }

  setModel(renderModel) {
    this.nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    this.setSelectedEdge(null);
  }

  setSelectedEdge(edge) {
    if (edge && this.nodesById.has(edge.from) && this.nodesById.has(edge.to)) {
      this.edge = edge;
      this.container.classList.add('st-edgechrome--on');
      return;
    }
    this.edge = null;
    this.container.classList.remove('st-edgechrome--on');
  }

  beginReconnect(end, event) {
    if (this.edge && this.onReconnectStart) this.onReconnectStart(this.edge, end, event);
    // Chrome stays --on so the captured handle keeps its pointer events.
  }

  update(camera) {
    if (!this.edge) return;
    const from = this.nodesById.get(this.edge.from);
    const to = this.nodesById.get(this.edge.to);
    const fx = (from.x - camera.x) * camera.zoom + camera.viewportWidth / 2;
    const fy = (from.y - camera.y) * camera.zoom + camera.viewportHeight / 2;
    const tx = (to.x - camera.x) * camera.zoom + camera.viewportWidth / 2;
    const ty = (to.y - camera.y) * camera.zoom + camera.viewportHeight / 2;
    const len = Math.hypot(tx - fx, ty - fy) || 1;
    const ux = (tx - fx) / len;
    const uy = (ty - fy) / len;

    this.place(this.cross, (fx + tx) / 2 - uy * CROSS_OFFSET, (fy + ty) / 2 + ux * CROSS_OFFSET);
    const rim = NODE_RADIUS * camera.zoom + HANDLE_GAP;
    this.place(this.handles[0], fx + ux * rim, fy + uy * rim);
    this.place(this.handles[1], tx - ux * rim, ty - uy * rim);
  }

  place(element, x, y) {
    element.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  }

  dispose() {
    this.container.remove();
  }
}
