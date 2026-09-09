// Pooled DOM overlays above the GPU canvas: each keeps a fixed set of absolutely-positioned
// elements in one container over the canvas, moved by CSS transform so a frame costs no layout.
//
// LabelOverlay — the captions. Every decision is scene/captionLayout.js (pure); this half measures
// text with a 2D canvas, re-measures once the fonts load, and mirrors the placer's answer into
// elements. The scene drives it with:
//   constructor(canvas, theme)         theme.BACKGROUND.canvas becomes the halo behind the glyphs
//   setModel(renderModel, spatialGrid) re-index and re-measure; existing captions keep their state
//   setStates(statesMap)               active/available rank ahead of the rest
//   setContext({ selectedId, hoveredId }) selected > hovered > the selected's trunk family — never dropped
//   setInsets({ top, right, bottom, left }) CSS px of chrome a caption may not sit under
//   setTheme(theme)                    re-pins the halo colour
//   update(camera, now?)               the one DOM-writing path; early-returns while nothing changed and no fade is due
//   dispose()
// A caption appears after SHOW_AFTER_MS of unbroken placement and leaves HIDE_AFTER_MS after
// losing it; both edges fade through the `st-label--shown` class, and a settle timer runs update
// at the next deadline (and after any setter) so the fade lands without a camera frame. Each
// element stays with its node id while the caption is on screen and carries it as data-node-id.
//
// IconOverlay — live `<Icon>` SVGs cross-fading in over the baked atlas glyph from ICON_DOM_START,
// on the ICON_POOL nodes nearest the viewport centre.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon } from '../../../design-system/Icon.jsx';
import { CAPTION, DEFAULT_NODE_COLOR, nodeTier, NODE_SIZE } from '../theme.js';
import { CAPTION_POOL, CaptionPlacer, wrapCaption } from './captionLayout.js';

const ICON_POOL = 64;
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
  constructor(canvas, className, poolSize) {
    this.container = document.createElement('div');
    this.container.className = className;
    this.container.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
    canvas.parentElement.appendChild(this.container);

    this.pool = Array.from({ length: poolSize }, () => {
      const element = this.createElement();
      this.container.appendChild(element);
      return element;
    });
  }

  dispose() {
    this.container.remove();
  }
}

export class LabelOverlay extends NodeOverlay {
  constructor(canvas, theme) {
    super(canvas, 'st-labels', CAPTION_POOL);
    this.placer = new CaptionPlacer();
    this.ruler = document.createElement('canvas').getContext('2d');
    this.nodes = [];
    this.metricByLabel = new Map();
    this.elementById = new Map();
    this.metricByElement = new Map();
    this.idle = [...this.pool]; // free elements, longest-free first, so a fade-out finishes before reuse
    this.camera = null;
    this.placedAt = { x: NaN, y: NaN, zoom: NaN, width: NaN, height: NaN };
    this.dirty = true;
    this.deadline = null;
    this.settleTimer = 0;
    this.onFontsLoaded = () => { this.metricByLabel.clear(); this.measureCaptions(); };
    document.fonts?.addEventListener('loadingdone', this.onFontsLoaded);
    if (theme) this.setTheme(theme); // without one the stylesheet's --surface-canvas token is the halo
  }

  createElement() {
    const span = document.createElement('span');
    span.className = 'st-label';
    span.style.cssText = 'position:absolute;left:0;top:0;will-change:transform;';
    return span;
  }

  setModel(renderModel, spatialGrid) {
    this.nodes = renderModel.nodes;
    this.placer.setModel(renderModel, spatialGrid);
    this.measureCaptions();
  }

  // One wrap per distinct label under the live caption font; the cache is rebuilt to the model's labels.
  measureCaptions() {
    this.ruler.font = `700 ${CAPTION.fontPx}px ${getComputedStyle(this.pool[0]).fontFamily || 'sans-serif'}`;
    const measure = (text) => this.ruler.measureText(text).width;
    const metricByLabel = new Map();
    const metricById = new Map();
    for (const node of this.nodes) {
      if (!metricByLabel.has(node.label)) metricByLabel.set(node.label, this.metricByLabel.get(node.label) ?? wrapCaption(node.label, measure));
      const metric = metricByLabel.get(node.label);
      if (metric) metricById.set(node.id, metric);
    }
    this.metricByLabel = metricByLabel;
    this.placer.setMetrics(metricById);
    this.refresh();
  }

  setStates(statesMap) {
    this.placer.setStates(statesMap);
    this.refresh();
  }

  setContext(context) {
    this.placer.setContext(context);
    this.refresh();
  }

  setInsets(insets) {
    this.placer.setInsets(insets);
    this.refresh();
  }

  setTheme(theme) {
    this.container.style.setProperty('--st-label-halo', theme.BACKGROUND.canvas);
  }

  // Inputs changed outside the frame loop: the next update re-places, and one is scheduled in case no frame comes.
  refresh() {
    this.dirty = true;
    if (this.camera) this.arm(0);
  }

  arm(delayMs) {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.update(this.camera), delayMs);
  }

  update(camera, now = performance.now()) {
    this.camera = camera;
    const at = this.placedAt;
    const moved = camera.x !== at.x || camera.y !== at.y || camera.zoom !== at.zoom
      || camera.viewportWidth !== at.width || camera.viewportHeight !== at.height;
    const due = this.deadline !== null && now >= this.deadline;
    if (!moved && !this.dirty && !due) return;

    at.x = camera.x;
    at.y = camera.y;
    at.zoom = camera.zoom;
    at.width = camera.viewportWidth;
    at.height = camera.viewportHeight;
    this.dirty = false;

    const { captions, nextDeadline } = this.placer.place(camera, now);
    this.draw(captions);
    this.deadline = nextDeadline;
    clearTimeout(this.settleTimer);
    this.settleTimer = 0;
    if (nextDeadline !== null) this.arm(Math.max(0, nextDeadline - now) + 1);
  }

  draw(captions) {
    const keep = new Set(captions.map((caption) => caption.id));
    for (const [id, element] of this.elementById) {
      if (keep.has(id)) continue;
      element.classList.remove('st-label--shown');
      delete element.dataset.nodeId;
      this.elementById.delete(id);
      this.metricByElement.delete(element);
      this.idle.push(element);
    }
    for (const caption of captions) {
      let element = this.elementById.get(caption.id);
      if (!element) {
        element = this.idle.shift();
        element.dataset.nodeId = caption.id;
        this.elementById.set(caption.id, element);
      }
      if (this.metricByElement.get(element) !== caption.lines) {
        this.metricByElement.set(element, caption.lines);
        element.textContent = caption.lines.join('\n');
        element.style.width = `${caption.width}px`;
      }
      element.style.transform = `translate(${caption.left}px, ${caption.top}px)`;
      element.classList.toggle('st-label--shown', caption.shown);
    }
  }

  dispose() {
    clearTimeout(this.settleTimer);
    document.fonts?.removeEventListener('loadingdone', this.onFontsLoaded);
    super.dispose();
  }
}

export class IconOverlay extends NodeOverlay {
  constructor(canvas, theme) {
    super(canvas, 'st-icons', ICON_POOL);
    this.theme = theme;
    this.nodesById = new Map();
    this.spatialGrid = null;
    this.assignedId = new Array(ICON_POOL).fill(null);
    this.hidden = true;
    this.markupByName = new Map();
    this.stateById = new Map();
    this.colorById = new Map();
  }

  createElement() {
    const div = document.createElement('div');
    div.className = 'st-icon';
    div.style.cssText = 'position:absolute;left:0;top:0;display:none;will-change:transform;';
    return div;
  }

  setModel(renderModel, spatialGrid) {
    this.nodesById = new Map(renderModel.nodes.map((node) => [node.id, node]));
    this.spatialGrid = spatialGrid;
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
    this.assignedId.fill(null);
    this.pool.forEach((element) => { element.style.display = 'none'; });
    this.hidden = true;
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

  // The ICON_POOL nodes nearest the viewport centre, LOD-gated by zoom; markup is rewritten only when a slot changes node.
  update(camera) {
    const strength = smoothstep(camera.zoom, ICON_DOM_START, ICON_DOM_FULL);
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
      .slice(0, ICON_POOL);

    const size = NODE_SIZE * ICON_NODE_FRACTION * camera.zoom;
    this.pool.forEach((element, i) => {
      const picked = nearest[i];
      if (!picked) { element.style.display = 'none'; this.assignedId[i] = null; return; }
      const node = this.nodesById.get(picked.id);
      const sx = (node.x - camera.x) * camera.zoom + camera.viewportWidth / 2;
      const sy = (node.y - camera.y) * camera.zoom + camera.viewportHeight / 2;
      element.style.display = 'block';
      element.style.width = `${size}px`;
      element.style.height = `${size}px`;
      element.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%)`;
      if (this.assignedId[i] !== node.id) {
        this.assignedId[i] = node.id;
        element.innerHTML = this.markupByName.get(node.icon) ?? '';
        element.style.color = glyphCssColor(this.theme, this.colorById.get(node.id), this.stateById.get(node.id));
      }
    });
  }
}
