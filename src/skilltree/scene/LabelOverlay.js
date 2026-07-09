// Node captions as pooled, absolutely-positioned DOM over the canvas — crisp at
// any zoom and cheap. A fixed pool (never one-per-node); above the zoom threshold
// we place the pool on the nodes nearest the viewport center and hide the rest.
import { NODE_SIZE } from '../theme.js';

const POOL_SIZE = 64;
const ZOOM_THRESHOLD = 0.5;

export class LabelOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.nodesById = new Map();
    this.spatialGrid = null;

    this.container = document.createElement('div');
    this.container.className = 'st-labels';
    this.container.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
    canvas.parentElement.appendChild(this.container);

    this.pool = Array.from({ length: POOL_SIZE }, () => {
      const span = document.createElement('span');
      span.className = 'st-label';
      span.style.cssText = 'position:absolute;transform:translate(-50%,0);white-space:nowrap;display:none;';
      this.container.appendChild(span);
      return span;
    });
    this.assignedId = new Array(POOL_SIZE).fill(null);
    this.hidden = true;
  }

  setModel(renderModel, spatialGrid) {
    this.nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    this.spatialGrid = spatialGrid;
    this.assignedId.fill(null);
    this.pool.forEach((span) => { span.style.display = 'none'; });
    this.hidden = true;
  }

  update(camera) {
    if (!this.spatialGrid || camera.zoom < ZOOM_THRESHOLD) {
      if (!this.hidden) { this.pool.forEach((s) => { s.style.display = 'none'; }); this.assignedId.fill(null); this.hidden = true; }
      return;
    }
    this.hidden = false;

    const view = camera.getViewport();
    const centerX = (view.minX + view.maxX) / 2;
    const centerY = (view.minY + view.maxY) / 2;
    const nearest = this.spatialGrid
      .within(view.minX, view.minY, view.maxX, view.maxY)
      .map((id) => { const n = this.nodesById.get(id); return { id, d: (n.x - centerX) ** 2 + (n.y - centerY) ** 2 }; })
      .sort((a, b) => a.d - b.d)
      .slice(0, POOL_SIZE);

    const offsetY = NODE_SIZE * 0.62 * camera.zoom;
    this.pool.forEach((span, i) => {
      const picked = nearest[i];
      if (!picked) { span.style.display = 'none'; this.assignedId[i] = null; return; }
      const node = this.nodesById.get(picked.id);
      const sx = (node.x - camera.x) * camera.zoom + camera.viewportWidth / 2;
      const sy = (node.y - camera.y) * camera.zoom + camera.viewportHeight / 2;
      span.style.display = 'block';
      span.style.left = `${sx}px`;
      span.style.top = `${sy + offsetY}px`;
      if (this.assignedId[i] !== node.id) { this.assignedId[i] = node.id; span.textContent = node.label; }
    });
  }

  dispose() {
    this.container.remove();
  }
}
