// DOM overlays above the GPU canvas: a fixed pool (never one element per node)
// placed on the nodes nearest the viewport center and LOD-gated by zoom — crisp
// at any zoom and cheap. LabelOverlay is captions below the node; IconOverlay is
// live SVG glyphs on the node that take over from the baked atlas once you zoom
// in far enough that the raster would soften. Both share one placement skeleton;
// each overrides only the element, its visibility band, and how it's drawn.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon } from '../../../design-system/Icon.jsx';
import { NODE_COLORS, DEFAULT_NODE_COLOR, BACKGROUND, nodeTier, NODE_SIZE } from '../theme.js';

const POOL_SIZE = 64;
const LABEL_ZOOM_THRESHOLD = 0.5;
export const ICON_DOM_START = 2.0;
export const ICON_DOM_FULL = 3.0;
const ICON_NODE_FRACTION = 0.44; // glyph share of the node diameter; matches the atlas inset
const LABEL_FONT_FRACTION = 0.23; // caption height as a share of the node diameter (~13px at zoom 1)

function smoothstep(x, edge0, edge1) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Mirrors the node shader's glyph so the high-zoom live glyph matches the baked
// one: a saturated node (available/activated) shows the bright `soft` tint of its
// kind; an unavailable node a muted mix of the kind toward the cream canvas.
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function glyphCssColor(color, state) {
  const family = NODE_COLORS[color] ?? NODE_COLORS[DEFAULT_NODE_COLOR];
  if (nodeTier(state) > 0) return `rgb(${rgb(family.soft).join(', ')})`;
  const [br, bg, bb] = rgb(family.base);
  const [cr, cg, cb] = rgb(BACKGROUND.canvas);
  const mix = (a, b) => Math.round(b + (a - b) * 0.55);
  return `rgb(${mix(br, cr)}, ${mix(bg, cg)}, ${mix(bb, cb)})`;
}

class NodeOverlay {
  constructor(canvas, className) {
    this.nodesById = new Map();
    this.spatialGrid = null;

    this.container = document.createElement('div');
    this.container.className = className;
    this.container.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
    canvas.parentElement.appendChild(this.container);

    this.pool = Array.from({ length: POOL_SIZE }, () => {
      const element = this.createElement();
      this.container.appendChild(element);
      return element;
    });
    this.assignedId = new Array(POOL_SIZE).fill(null);
    this.hidden = true;
  }

  setModel(renderModel, spatialGrid) {
    this.nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    this.spatialGrid = spatialGrid;
    this.assignedId.fill(null);
    this.pool.forEach((element) => { element.style.display = 'none'; });
    this.hidden = true;
  }

  update(camera) {
    const strength = this.visibility(camera.zoom);
    if (!this.spatialGrid || strength <= 0) {
      if (!this.hidden) { this.pool.forEach((e) => { e.style.display = 'none'; }); this.assignedId.fill(null); this.hidden = true; }
      return;
    }
    this.hidden = false;
    this.container.style.opacity = strength;

    const view = camera.getViewport();
    const centerX = (view.minX + view.maxX) / 2;
    const centerY = (view.minY + view.maxY) / 2;
    const nearest = this.spatialGrid
      .within(view.minX, view.minY, view.maxX, view.maxY)
      .map((id) => { const n = this.nodesById.get(id); return { id, d: (n.x - centerX) ** 2 + (n.y - centerY) ** 2 }; })
      .sort((a, b) => a.d - b.d)
      .slice(0, POOL_SIZE);

    this.pool.forEach((element, i) => {
      const picked = nearest[i];
      if (!picked) { element.style.display = 'none'; this.assignedId[i] = null; return; }
      const node = this.nodesById.get(picked.id);
      const sx = (node.x - camera.x) * camera.zoom + camera.viewportWidth / 2;
      const sy = (node.y - camera.y) * camera.zoom + camera.viewportHeight / 2;
      element.style.display = 'block';
      this.place(element, sx, sy, camera.zoom);
      if (this.assignedId[i] !== node.id) { this.assignedId[i] = node.id; this.render(element, node); }
    });
  }

  dispose() {
    this.container.remove();
  }
}

export class LabelOverlay extends NodeOverlay {
  constructor(canvas) {
    super(canvas, 'st-labels');
  }

  createElement() {
    const span = document.createElement('span');
    span.className = 'st-label';
    span.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;display:none;will-change:transform;';
    return span;
  }

  visibility(zoom) {
    return zoom >= LABEL_ZOOM_THRESHOLD ? 1 : 0;
  }

  place(element, sx, sy, zoom) {
    const offsetY = NODE_SIZE * 0.62 * zoom;
    element.style.fontSize = `${NODE_SIZE * LABEL_FONT_FRACTION * zoom}px`;
    element.style.transform = `translate(${sx}px, ${sy + offsetY}px) translate(-50%, 0)`;
  }

  render(element, node) {
    element.textContent = node.label;
  }
}

export class IconOverlay extends NodeOverlay {
  constructor(canvas) {
    super(canvas, 'st-icons');
    this.markupByName = new Map();
    this.stateById = new Map();
    this.colorById = new Map();
  }

  setModel(renderModel, spatialGrid) {
    this.markupByName = new Map();
    this.stateById = new Map();
    this.colorById = new Map();
    for (const node of renderModel.nodes) {
      this.stateById.set(node.id, node.state);
      this.colorById.set(node.id, node.color);
      if (!this.markupByName.has(node.icon)) {
        this.markupByName.set(node.icon, renderToStaticMarkup(createElement(Icon, { name: node.icon, strokeWidth: 2.25 })));
      }
    }
    super.setModel(renderModel, spatialGrid);
  }

  setStates(statesMap) {
    for (const [id, state] of statesMap) this.stateById.set(id, state);
    this.pool.forEach((element, i) => {
      const id = this.assignedId[i];
      if (id !== null) element.style.color = glyphCssColor(this.colorById.get(id), this.stateById.get(id));
    });
  }

  createElement() {
    const div = document.createElement('div');
    div.className = 'st-icon';
    div.style.cssText = 'position:absolute;left:0;top:0;display:none;will-change:transform;';
    return div;
  }

  visibility(zoom) {
    return smoothstep(zoom, ICON_DOM_START, ICON_DOM_FULL);
  }

  place(element, sx, sy, zoom) {
    const size = NODE_SIZE * ICON_NODE_FRACTION * zoom;
    element.style.width = `${size}px`;
    element.style.height = `${size}px`;
    element.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%)`;
  }

  render(element, node) {
    element.innerHTML = this.markupByName.get(node.icon) ?? '';
    element.style.color = glyphCssColor(this.colorById.get(node.id), this.stateById.get(node.id));
  }
}
