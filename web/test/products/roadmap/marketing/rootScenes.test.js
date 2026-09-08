// The roadmap's two stills are the only root scenes with a life of their own: they build a world in
// the DOM, hold a ResizeObserver each, share one MutationObserver on the hour, and — the section
// tree — gate the page's one infinite animation on an audience. So this drives the real mounts
// against a document just real enough to hold a world: the part that can be wrong in silence is the
// teardown and the gate, not the markup.

import test from 'node:test';
import assert from 'node:assert/strict';

const DORMANT = '#D3C2A0';   // theme.js CONNECTOR.inactive, by day
const LIT = '#9C6B44';       // theme.js BARK
const CROWN_AT_REST = '0 0 0 4px color-mix(in srgb, var(--kind-terracotta) 28%, transparent), '
  + '0 0 26px 5px color-mix(in srgb, var(--kind-terracotta) 28%, transparent)';

// One stage inside one frame, standing on a ground that carries the hour — which is how a scene
// reads it, through closest('[data-theme]'). The three observers are kept so a test can fire them
// and can see which ones a teardown let go of.
function ground({ reduced = false, night = false } = {}) {
  const watches = [];
  class Watch {
    constructor(kind, callback) { this.kind = kind; this.callback = callback; this.live = true; watches.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.live = false; }
  }

  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.attrs = {};
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.text = '';
      this.classes = new Set();
      this.style = { cssText: '' };
      this.clientWidth = 560;
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
    setAttribute(name, value) {
      if (name === 'class') this.className = value;
      else if (name === 'style') this.style.cssText = String(value);
      else this.attrs[name] = String(value);
    }
    getAttribute(name) { return name === 'class' ? this.className : this.attrs[name] ?? null; }
    removeAttribute(name) {
      if (name === 'style') this.style = { cssText: '' };
      else delete this.attrs[name];
    }
    set innerHTML(value) {
      this.children.forEach((child) => { child.parentElement = null; });
      this.children = [];
      this.text = String(value);
    }
    get innerHTML() { return this.text; }
    closest(selector) {
      const name = selector.slice(1, -1);
      for (let node = this; node; node = node.parentElement) if (node.attrs[name] != null) return node;
      return null;
    }
  }

  const root = new Element('html');
  // A scene is handed the stage; the frame around it is what it measures itself against.
  const plot = () => {
    const frame = new Element('div');
    if (night) frame.setAttribute('data-theme', 'dark');
    return frame.appendChild(new Element('div'));
  };
  const stage = plot();

  globalThis.matchMedia = () => ({ matches: reduced });
  globalThis.document = {
    documentElement: root,
    createElement: (tag) => new Element(tag),
    createElementNS: (namespace, tag) => new Element(tag),
  };
  globalThis.ResizeObserver = class { constructor(callback) { return new Watch('resize', callback); } };
  globalThis.MutationObserver = class { constructor(callback) { return new Watch('mutation', callback); } };
  globalThis.IntersectionObserver = class { constructor(callback) { return new Watch('intersection', callback); } };

  return {
    stage,
    plot,
    watchesOf: (kind) => watches.filter((watch) => watch.kind === kind),
    live: (kind) => watches.filter((watch) => watch.kind === kind && watch.live).length,
    // the audience arriving and leaving, as the IntersectionObserver reports it
    seen: (yes) => watches.filter((watch) => watch.kind === 'intersection' && watch.live)
      .forEach((watch) => watch.callback([{ isIntersecting: yes }])),
  };
}

// PRM is read once, when treeScenes is loaded, so each motion mode gets its own module instance.
const load = (reduced) => import(`../../../../src/products/roadmap/marketing/treeScenes.js?reduced=${reduced}`);

const nodesOf = (stage) => stage.children.filter((child) => child.classList.contains('nd'));
const labelsOf = (stage) => stage.children.filter((child) => child.classList.contains('ndlabel'));
const edgesOf = (stage) => stage.children.find((child) => child.tagName === 'svg').children;
// An inline style beats a presentation attribute, so this is the opacity the edge actually draws at.
const inkOf = (edge) => ({
  stroke: edge.getAttribute('stroke'),
  width: edge.getAttribute('stroke-width'),
  opacity: String(edge.style.opacity ?? edge.getAttribute('opacity')),
});

test('the glimpse crops nine nodes out of the sail tree and draws its contracted edge as dormant as the rest', async () => {
  const dom = ground();
  const { mountGlimpse } = await load(false);
  const teardown = mountGlimpse(dom.stage);

  assert.equal(nodesOf(dom.stage).length, 9);
  assert.equal(labelsOf(dom.stage).length, 9);
  assert.deepEqual(edgesOf(dom.stage).map(inkOf), [
    { stroke: LIT, width: '2.2', opacity: '0.9' },      // r → Knots & lines
    { stroke: LIT, width: '2.2', opacity: '0.9' },      // r → Rig the mast
    { stroke: LIT, width: '2.2', opacity: '0.9' },      // r → Read the wind
    { stroke: LIT, width: '2.2', opacity: '0.9' },      // r → Capsize drill
    { stroke: LIT, width: '2.2', opacity: '0.9' },      // Knots & lines → Cleats & hitches
    { stroke: DORMANT, width: '1.5', opacity: '0.8' },  // Rig the mast → Points of sail
    { stroke: DORMANT, width: '1.5', opacity: '0.8' },  // Points of sail → Reefing
    // the contracted Read the wind → Tides & currents, drawn from a done node and dormant anyway
    { stroke: DORMANT, width: '1.5', opacity: '0.8' },
  ]);
  // Its crown is a still halo by choice: the glimpse loops nothing at all.
  assert.equal(nodesOf(dom.stage)[0].style.boxShadow, CROWN_AT_REST);
  assert.equal(nodesOf(dom.stage).some((node) => node.classList.contains('nd--crown')), false);
  teardown();
});

test('the section tree draws the whole sail world — seventeen nodes, seventeen edges, every label', async () => {
  const dom = ground();
  const { mountSectionTree } = await load(false);
  const teardown = mountSectionTree(dom.stage);

  assert.equal(nodesOf(dom.stage).length, 17);
  assert.equal(labelsOf(dom.stage).length, 17);
  assert.equal(edgesOf(dom.stage).length, 17);
  teardown();
});

test('at night a still repaints its edges off the ground it stands on, not off <html>', async () => {
  const dom = ground({ night: true });
  const { mountSectionTree } = await load(false);
  const teardown = mountSectionTree(dom.stage);

  const strokes = new Set(edgesOf(dom.stage).map((edge) => edge.getAttribute('stroke')));
  assert.deepEqual([...strokes].sort(), ['#2E2E32', '#6E5D49'], 'the night connector and the night bark');
  teardown();
});

// The crown is the one infinite animation the brand root runs, and the section tree stands ~1800px
// below the fold: unwatched, it looped forever for a visitor who never scrolled to it.
test('the crown loops only while the section has an audience', async () => {
  const dom = ground();
  const { mountSectionTree } = await load(false);
  const teardown = mountSectionTree(dom.stage);
  const crown = nodesOf(dom.stage)[0];

  assert.equal(crown.classList.contains('nd--crown'), false, 'it starts still, below the fold');
  dom.seen(true);
  assert.equal(crown.classList.contains('nd--crown'), true);
  dom.seen(false);
  assert.equal(crown.classList.contains('nd--crown'), false, 'it stops again when the section leaves');
  teardown();
});

test('under reduced motion the crown wears the still halo and no observer watches for an audience', async () => {
  const dom = ground({ reduced: true });
  const { mountSectionTree } = await load(true);
  const teardown = mountSectionTree(dom.stage);
  const crown = nodesOf(dom.stage)[0];

  assert.equal(crown.style.boxShadow, CROWN_AT_REST);
  assert.equal(crown.classList.contains('nd--crown'), false);
  assert.equal(dom.live('intersection'), 0, 'nothing to gate, so nothing is watching');
  teardown();
});

// A still is mounted through useScene, which calls the mount and keeps what it hands back for the
// unmount. A teardown that let go of anything would leave an observer holding a detached stage, and
// a stage it did not empty would grow a second world on the next mount.
test('a mount hands back a teardown that lets go of every observer and empties the stage', async () => {
  const dom = ground();
  const { mountGlimpse, mountSectionTree } = await load(false);

  const second = dom.plot();
  const teardowns = [mountGlimpse(dom.stage), mountSectionTree(second)];
  assert.equal(typeof teardowns[0], 'function');
  assert.equal(typeof teardowns[1], 'function');
  assert.deepEqual([dom.live('resize'), dom.live('intersection')], [2, 1]);
  assert.equal(dom.live('mutation'), 1, 'one observer on the hour, shared by both scenes');

  teardowns[0]();
  assert.equal(dom.live('mutation'), 1, 'the hour is still watched while a scene is still standing');
  teardowns[1]();

  assert.deepEqual([dom.live('resize'), dom.live('intersection'), dom.live('mutation')], [0, 0, 0]);
  for (const stage of [dom.stage, second]) {
    assert.deepEqual(stage.children, [], 'a world is left standing for the next mount to stack on');
    assert.equal(stage.style.cssText, '', 'the stage keeps the width and height the still gave it');
  }
});
