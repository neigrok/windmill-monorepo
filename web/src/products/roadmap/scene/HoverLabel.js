// Hover name tip: a pill below the hovered node, repositioned from the render loop.
import { NODE_SIZE } from '../theme.js';

const NODE_RADIUS = NODE_SIZE * 0.42;
const LABEL_GAP = 10; // screen px

export class HoverLabel {
  constructor(canvas) {
    this.pill = document.createElement('div');
    this.pill.style.cssText = [
      'position:absolute', 'left:0', 'top:0', 'z-index:12',
      'padding:4px 9px', 'border-radius:8px',
      'background:#2A231A', 'color:#F4EFE6',
      'font-size:11px', 'font-weight:600', 'line-height:1.3', 'white-space:nowrap',
      'opacity:0', 'pointer-events:none',
      'transition:opacity 150ms ease', 'will-change:transform,opacity',
    ].join(';');
    canvas.parentElement.appendChild(this.pill);
    this.nodesById = new Map();
    this.hoveredId = null;
  }

  setModel(renderModel) {
    this.nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    this.setHovered(null);
  }

  setHovered(id) {
    const node = this.nodesById.get(id);
    if (!node || !node.label) {
      this.hoveredId = null;
      this.pill.style.opacity = '0';
      return;
    }
    this.hoveredId = id;
    this.pill.textContent = node.label;
    this.pill.style.opacity = '1';
  }

  update(camera) {
    const node = this.hoveredId ? this.nodesById.get(this.hoveredId) : null;
    if (!node) return;
    const sx = (node.x - camera.x) * camera.zoom + camera.viewportWidth / 2;
    const sy = (node.y - camera.y) * camera.zoom + camera.viewportHeight / 2 + NODE_RADIUS * camera.zoom + LABEL_GAP;
    this.pill.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, 0)`;
  }

  dispose() {
    this.pill.remove();
  }
}
