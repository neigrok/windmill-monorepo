// The DOM half of the captions, driven against a document just real enough to hold a pool of
// spans and a measuring canvas: what can be wrong in silence is the mirror — which element a node
// keeps, when the shown class flips, what a font load or a chrome change redraws, and what dispose lets go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { SpatialGrid } from '../../../../src/products/roadmap/model/SpatialGrid.js';
import { NODE_SIZE, BODY_FRACTION, sceneTheme } from '../../../../src/products/roadmap/theme.js';
import { CAPTION_POOL, HIDE_AFTER_MS, SHOW_AFTER_MS } from '../../../../src/products/roadmap/scene/captionLayout.js';

// `node --test` speaks no JSX, and the icon overlay renders the design system's Icon.
register('../../../jsxLoader.mjs', import.meta.url);
const { LabelOverlay, IconOverlay, ICON_DOM_START, ICON_DOM_FULL } = await import('../../../../src/products/roadmap/scene/NodeOverlay.js');

const RIM = NODE_SIZE * BODY_FRACTION / 2;

// A stage with a canvas in it, a document whose 2D context measures `charPx` per code point, and
// a font registry that remembers who listens. `mount` registers an overlay for disposal; the
// globals come back once every mounted overlay is gone.
function stage(t, { charPx = 8 } = {}) {
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.textContent = '';
      this.innerHTML = '';
      this.classes = new Set();
      this.style = { cssText: '', setProperty(name, value) { this[name] = value; } };
    }
    get className() { return [...this.classes].join(' '); }
    set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
    get classList() {
      const classes = this.classes;
      return {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      };
    }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
    getContext() { return { font: '', measureText: (text) => ({ width: Array.from(text).length * ruler.charPx }) }; }
  }
  const ruler = { charPx };
  const fonts = { listeners: new Set(), addEventListener: (type, fn) => fonts.listeners.add(fn), removeEventListener: (type, fn) => fonts.listeners.delete(fn) };
  const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  globalThis.document = { createElement: (tag) => new Element(tag), fonts };
  globalThis.getComputedStyle = () => ({ fontFamily: 'Nunito, sans-serif' });
  const mounted = [];
  t.after(() => {
    mounted.forEach((overlay) => overlay.dispose());
    globalThis.document = saved.document;
    globalThis.getComputedStyle = saved.getComputedStyle;
  });

  const frame = new Element('div');
  const canvas = frame.appendChild(new Element('canvas'));
  return { frame, canvas, ruler, fonts, mount: (overlay) => { mounted.push(overlay); return overlay; } };
}

function model(nodes, edges = []) {
  const renderNodes = nodes.map((node) => ({ state: 'complete', emphasis: 0, branch: null, icon: 'star', color: 'olive', ...node }));
  return { renderModel: { nodes: renderNodes, edges, bounds: {} }, spatialGrid: new SpatialGrid(renderNodes, NODE_SIZE * 2) };
}

// A still camera centred on the origin at zoom 1: a world unit is a px and (0, 0) is mid-canvas.
function camera({ x = 0, y = 0, zoom = 1 } = {}) {
  const cam = { x, y, zoom, viewportWidth: 1440, viewportHeight: 848 };
  cam.getViewport = () => ({ minX: x - 720 / zoom, maxX: x + 720 / zoom, minY: y - 424 / zoom, maxY: y + 424 / zoom });
  return cam;
}

const labelsOf = (overlay) => overlay.container.children;
const assigned = (overlay) => labelsOf(overlay).filter((element) => element.dataset.nodeId !== undefined);
const captionOf = (overlay, id) => assigned(overlay).find((element) => element.dataset.nodeId === id);
const shown = (element) => element.classList.contains('st-label--shown');

test('LabelOverlay — one container of 96 captions over the canvas, the halo pinned to the scene theme', (t) => {
  const { frame, canvas, mount } = stage(t);
  const overlay = mount(new LabelOverlay(canvas, sceneTheme(false)));
  assert.deepEqual(frame.children.map((child) => child.className), ['', 'st-labels']);
  assert.equal(labelsOf(overlay).length, CAPTION_POOL);
  assert.ok(labelsOf(overlay).every((element) => element.className === 'st-label' && element.style.cssText.includes('will-change:transform')));
  assert.equal(overlay.container.style['--st-label-halo'], '#F9F5EB');
  overlay.setTheme(sceneTheme(true));
  assert.equal(overlay.container.style['--st-label-halo'], '#0B0B0C');
  mount(new IconOverlay(canvas, sceneTheme(false)));
  assert.deepEqual(frame.children.map((child) => child.className), ['', 'st-labels', 'st-icons']);
});

test('LabelOverlay — a caption is measured, wrapped and seated; it fades in after the wait and keeps its element across a pan', (t) => {
  const { canvas, mount } = stage(t);
  const overlay = mount(new LabelOverlay(canvas, sceneTheme(false)));
  overlay.setModel(...Object.values(model([
    { id: 'a', label: 'Build a daily habit and reflect', x: 0, y: 0 },
    { id: 'blank', label: '', x: 300, y: 0 },
  ])));
  assert.equal(overlay.ruler.font, '700 14px Nunito, sans-serif');

  overlay.update(camera(), 1000);
  assert.deepEqual(assigned(overlay).map((element) => element.dataset.nodeId), ['a']);
  const element = captionOf(overlay, 'a');
  assert.equal(element.textContent, 'Build a daily habit\nand reflect');
  assert.equal(element.style.width, '160px');
  assert.equal(element.style.transform, `translate(${720 - 80}px, ${424 + RIM + 8}px)`);
  assert.equal(shown(element), false);

  overlay.update(camera(), 1000 + SHOW_AFTER_MS);
  assert.equal(shown(element), true);
  overlay.update(camera({ x: -3, y: -5 }), 1000 + SHOW_AFTER_MS + 16);
  assert.equal(captionOf(overlay, 'a'), element);
  assert.equal(element.style.transform, `translate(${720 - 80 + 3}px, ${424 + RIM + 8 + 5}px)`);
});

test('LabelOverlay — a settle moves the discs under a still camera, and every caption follows on the next frame', (t) => {
  const { canvas, mount } = stage(t);
  const overlay = mount(new LabelOverlay(canvas, sceneTheme(false)));
  const { renderModel, spatialGrid } = model([{ id: 'a', label: 'Alpha', x: 0, y: 0 }]);
  overlay.setModel(renderModel, spatialGrid);
  const still = camera();
  overlay.update(still, 1000);
  overlay.update(still, 1000 + SHOW_AFTER_MS);
  const element = captionOf(overlay, 'a');
  assert.equal(element.style.transform, `translate(${720 - 24}px, ${424 + RIM + 8}px)`);

  // What a settle frame does: the scene eases the node to its new seat and marks the overlay. The camera never moves,
  // so without the mark the caption would hang where the disc used to be.
  const node = renderModel.nodes[0];
  node.x = 260;
  node.y = 104;
  spatialGrid.move('a', node.x, node.y);
  overlay.markMoved();
  assert.equal(overlay.settleTimer, 0, 'a move arms no timer: the frame loop is already coming');
  overlay.update(still, 1000 + SHOW_AFTER_MS + 16);
  assert.equal(captionOf(overlay, 'a'), element);
  assert.equal(element.style.transform, `translate(${720 + 260 - 24}px, ${424 + 104 + RIM + 8}px)`);
  assert.equal(shown(element), true);
});

test('LabelOverlay — an unchanged camera costs nothing; a fade deadline, a state, a context or an inset change re-places', (t) => {
  const { canvas, mount } = stage(t);
  const overlay = mount(new LabelOverlay(canvas, sceneTheme(false)));
  overlay.setModel(...Object.values(model([{ id: 'a', label: 'Alpha', x: 0, y: 0 }, { id: 'b', label: 'Beta', x: 500, y: 0 }])));
  let passes = 0;
  const place = overlay.placer.place.bind(overlay.placer);
  overlay.placer.place = (view, now) => { passes += 1; return place(view, now); };

  overlay.update(camera(), 1000);
  overlay.update(camera(), 1050);
  overlay.update(camera(), 1100);
  assert.equal(passes, 1);
  overlay.update(camera(), 1000 + SHOW_AFTER_MS);
  assert.equal(passes, 2);
  assert.ok(shown(captionOf(overlay, 'a')) && shown(captionOf(overlay, 'b')));
  overlay.update(camera(), 2000);
  assert.equal(passes, 2);

  for (const change of [() => overlay.setStates(new Map([['b', 'available']])), () => overlay.setContext({ selectedId: 'a', hoveredId: null }), () => overlay.setInsets({ right: 1000 })]) {
    const before = passes;
    change();
    assert.equal(passes, before);
    overlay.update(camera(), 2000);
    assert.equal(passes, before + 1);
  }
  // b sits under the inset now: it holds through the fade window, then its element is released.
  assert.equal(shown(captionOf(overlay, 'b')), true);
  overlay.update(camera(), 2000 + HIDE_AFTER_MS);
  assert.equal(captionOf(overlay, 'b'), undefined);
  assert.equal(shown(captionOf(overlay, 'a')), true);
});

test('LabelOverlay — the fonts loading re-measures every label in place, on the same elements', (t) => {
  const { canvas, ruler, fonts, mount } = stage(t, { charPx: 4 });
  const overlay = mount(new LabelOverlay(canvas, sceneTheme(false)));
  overlay.setModel(...Object.values(model([{ id: 'a', label: 'Build a daily habit and reflect', x: 0, y: 0 }])));
  overlay.update(camera(), 1000);
  overlay.update(camera(), 1000 + SHOW_AFTER_MS);
  const element = captionOf(overlay, 'a');
  assert.equal(element.textContent, 'Build a daily habit and reflect');
  assert.equal(element.style.width, '132px');

  ruler.charPx = 8;
  assert.equal(fonts.listeners.size, 1);
  for (const listener of fonts.listeners) listener();
  overlay.update(camera(), 1300);
  assert.equal(captionOf(overlay, 'a'), element);
  assert.equal(element.textContent, 'Build a daily habit\nand reflect');
  assert.equal(element.style.width, '160px');
  assert.equal(shown(element), true);
});

test('LabelOverlay — the pending fade is armed on a timer, and dispose lets go of the timer, the fonts and the container', (t) => {
  const { frame, canvas, fonts } = stage(t);
  const timers = [];
  const saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  globalThis.setTimeout = (fn, delay) => { timers.push({ fn, delay, cleared: false }); return timers.length; };
  globalThis.clearTimeout = (handle) => { if (timers[handle - 1]) timers[handle - 1].cleared = true; };
  t.after(() => { globalThis.setTimeout = saved.setTimeout; globalThis.clearTimeout = saved.clearTimeout; });

  const overlay = new LabelOverlay(canvas, sceneTheme(false));
  overlay.setModel(...Object.values(model([{ id: 'a', label: 'Alpha', x: 0, y: 0 }])));
  overlay.update(camera(), 1000);
  assert.deepEqual(timers.map(({ delay, cleared }) => ({ delay, cleared })), [{ delay: SHOW_AFTER_MS + 1, cleared: false }]);
  // A setter re-arms at once, superseding the fade timer; the pass it schedules is the ordinary update.
  overlay.setContext({ selectedId: 'a', hoveredId: null });
  assert.deepEqual(timers.map(({ delay, cleared }) => ({ delay, cleared })), [{ delay: SHOW_AFTER_MS + 1, cleared: true }, { delay: 0, cleared: false }]);
  timers[1].fn();
  assert.equal(shown(captionOf(overlay, 'a')), true);

  overlay.dispose();
  assert.ok(timers.every((timer) => timer.cleared));
  assert.equal(fonts.listeners.size, 0);
  assert.deepEqual(frame.children.map((child) => child.tagName), ['canvas']);
});

test('IconOverlay — the nearest 64 nodes wear a live glyph once the atlas fades, tinted per kind and state', (t) => {
  const { canvas, mount } = stage(t);
  const overlay = mount(new IconOverlay(canvas, sceneTheme(false)));
  overlay.setModel(...Object.values(model([
    { id: 'lit', label: 'Lit', x: 0, y: 0, state: 'complete', color: 'olive' },
    { id: 'locked', label: 'Locked', x: 40, y: 0, state: 'locked', color: 'olive' },
  ])));
  overlay.update(camera({ zoom: (ICON_DOM_START + ICON_DOM_FULL) / 2 }));
  const worn = overlay.container.children.filter((element) => element.style.display === 'block');
  assert.equal(worn.length, 2);
  assert.ok(worn.every((element) => element.innerHTML.includes('<svg')));
  assert.deepEqual(worn.map((element) => element.style.color), ['rgb(210, 218, 165)', 'rgb(181, 187, 143)']);
  assert.equal(overlay.container.style.opacity, 0.5);

  overlay.update(camera({ zoom: 1 }));
  assert.equal(overlay.container.children.filter((element) => element.style.display === 'block').length, 0);
});
