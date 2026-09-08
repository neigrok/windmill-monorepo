// Fixed DOM pools above the GPU canvas; captions reserve readable screen-space rectangles.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon } from '../../../design-system/Icon.jsx';
import { DEFAULT_NODE_COLOR, nodeTier, NODE_SIZE } from '../theme.js';
import { sceneHierarchy, OVERVIEW_BODY_DIAMETER } from './sceneHierarchy.js';
import { LABEL_FONT_SIZE, LABEL_LINE_HEIGHT, NODE_BODY_DIAMETER } from '../model/geometry.js';
import { LABEL_POOL_SIZE, wrapCaption, placeCaptions, captionCandidates } from './captionLayout.js';

const POOL_SIZE = LABEL_POOL_SIZE;
export const ICON_DOM_START = 2.0;
export const ICON_DOM_FULL = 3.0;
const ICON_NODE_FRACTION = 0.44; // glyph share of node diameter; matches the atlas inset

function smoothstep(x, edge0, edge1) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Must match the node shader's glyph tint.
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function glyphCssColor(theme, color, state) {
  const family = theme.NODE_COLORS[color] ?? theme.NODE_COLORS[DEFAULT_NODE_COLOR];
  if (nodeTier(state) > 0) return `rgb(${rgb(family.soft).join(', ')})`;
  const [br, bg, bb] = rgb(family.base);
  const [cr, cg, cb] = rgb(theme.BACKGROUND.canvas);
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
    const visible = this.spatialGrid.within(view.minX, view.minY, view.maxX, view.maxY).map((id) => this.nodesById.get(id));
    const nearest = captionCandidates(visible, camera).slice(0, POOL_SIZE);

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
    this.metrics = new Map();
    this.captionCache = new Map();
    this.neighborsById = new Map();
    this.selectedId = null;
    this.hoveredId = null;
    this.onFontsReady = () => {
      if (!this.container.isConnected) return;
      this.captionCache.clear();
      this.measureCaptions();
    };
    document.fonts?.addEventListener('loadingdone', this.onFontsReady);
  }

  createElement() {
    const span = document.createElement('span');
    span.className = 'st-label';
    span.style.cssText = 'position:absolute;left:0;top:0;display:none;will-change:transform;';
    return span;
  }

  setModel(renderModel, spatialGrid) {
    super.setModel(renderModel, spatialGrid);
    this.hierarchy = sceneHierarchy(renderModel.nodes, renderModel.edges);
    this.neighborsById = new Map(renderModel.nodes.map((node) => [node.id, new Set()]));
    for (const edge of renderModel.edges) {
      this.neighborsById.get(edge.from)?.add(edge.to);
      this.neighborsById.get(edge.to)?.add(edge.from);
    }
    this.measureCaptions();
  }

  measureCaptions() {
    const font = getComputedStyle(this.pool[0]).fontFamily;
    const context = document.createElement('canvas').getContext('2d');
    context.font = `700 ${LABEL_FONT_SIZE}px ${font}`;
    const next = new Map();
    for (const node of this.nodesById.values()) {
      const key = `${context.font}|${node.label}`;
      let metric = this.captionCache.get(key);
      if (!metric) {
        metric = wrapCaption(node.label, (text) => context.measureText(text).width);
        this.captionCache.set(key, metric);
      }
      next.set(node.id, metric);
    }
    for (const summary of this.hierarchy?.summaries ?? []) {
      const metric = wrapCaption(summary.label, (text) => context.measureText(text).width);
      const count = `${summary.count.toLocaleString()} ${summary.count === 1 ? 'step' : 'steps'}`;
      next.set(summary.id, { text: `${metric.text}\n${count}`, width: Math.max(metric.width, context.measureText(count).width) + 6, height: metric.height + LABEL_LINE_HEIGHT });
    }
    this.metrics = next;
    if (this.captionCache.size > this.nodesById.size * 2 + 100) this.captionCache.clear();
    this.assignedId.fill(null);
    if (this.camera) this.update(this.camera, this.obstacles);
  }

  setStates(states) {
    for (const [id, state] of states) {
      const node = this.nodesById.get(id);
      if (node) node.state = state;
    }
  }

  setContext(selectedId, hoveredId = this.hoveredId) {
    this.selectedId = selectedId;
    this.hoveredId = hoveredId;
  }

  update(camera, obstacles = []) {
    this.camera = camera;
    this.obstacles = obstacles;
    if (!this.spatialGrid) return;
    const view = camera.getViewport();
    const pad = NODE_SIZE * 2;
    const nodes = this.spatialGrid.within(view.minX - pad, view.minY - pad, view.maxX + pad, view.maxY + pad)
      .map((id) => this.nodesById.get(id));
    const overview = NODE_BODY_DIAMETER * camera.zoom < OVERVIEW_BODY_DIAMETER;
    const summaries = overview ? this.hierarchy.summaries : [];
    const bySummaryId = new Map(summaries.map((summary) => [summary.id, summary]));
    nodes.push(...summaries);
    const placements = placeCaptions(nodes, camera, this.metrics, {
      selectedId: this.selectedId,
      hoveredId: this.hoveredId,
      neighbors: this.neighborsById.get(this.selectedId ?? this.hoveredId) ?? new Set(),
      anchors: overview ? new Set(bySummaryId.keys()) : this.hierarchy.anchors,
      retained: new Set(this.assignedId.filter(Boolean)),
      obstacles,
    });
    const byId = new Map(placements.map((placement) => [placement.id, placement]));
    const assigned = new Set();
    this.assignedId.forEach((id, i) => {
      if (byId.has(id)) assigned.add(id);
      else { this.assignedId[i] = null; this.pool[i].style.display = 'none'; }
    });
    let slot = 0;
    for (const placement of placements) {
      if (assigned.has(placement.id)) continue;
      while (this.assignedId[slot] != null) slot += 1;
      this.assignedId[slot] = placement.id;
      const element = this.pool[slot];
      const metric = this.metrics.get(placement.id);
      element.textContent = metric.text;
      const summary = bySummaryId.get(placement.id);
      if (summary) {
        delete element.dataset.nodeId;
        element.dataset.branchId = summary.sourceId;
        element.style.setProperty('--summary-color', `var(--kind-${summary.color ?? DEFAULT_NODE_COLOR})`);
      } else {
        delete element.dataset.branchId;
        element.dataset.nodeId = placement.id;
      }
      element.style.width = `${metric.width + 8}px`;
    }
    this.assignedId.forEach((id, i) => {
      const placement = byId.get(id);
      if (!placement) return;
      const element = this.pool[i];
      element.style.display = 'block';
      element.classList.toggle('st-label--selected', id === this.selectedId);
      element.classList.toggle('st-label--anchor', placement.anchor && !bySummaryId.has(id));
      element.classList.toggle('st-label--summary', bySummaryId.has(id));
      element.style.transform = `translate(${placement.left}px, ${placement.top}px)`;
    });
  }

  dispose() {
    document.fonts?.removeEventListener('loadingdone', this.onFontsReady);
    super.dispose();
  }
}

export class IconOverlay extends NodeOverlay {
  constructor(canvas, theme) {
    super(canvas, 'st-icons');
    this.theme = theme;
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
    this.retint();
  }

  setTheme(theme) {
    this.theme = theme;
    this.retint();
  }

  retint() {
    this.pool.forEach((element, i) => {
      const id = this.assignedId[i];
      if (id !== null) element.style.color = glyphCssColor(this.theme, this.colorById.get(id), this.stateById.get(id));
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
    element.style.color = glyphCssColor(this.theme, this.colorById.get(node.id), this.stateById.get(node.id));
  }
}
