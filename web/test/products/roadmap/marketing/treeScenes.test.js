// The landing's tree worlds build themselves in the DOM, so this drives a real mount against a document
// just real enough to hold one.

import test from 'node:test';
import assert from 'node:assert/strict';

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
    addEventListener() {}
    querySelector(selector) {
      assert.equal(selector, '.ct');
      return { textContent: '6' };
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

  globalThis.cancelAnimationFrame = () => {};
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

test('the hero completion toast keeps its emphasized count and approved state words', async () => {
  const dom = ground({ reduced: true });
  const { mountHero } = await load(true);
  const hero = mountHero(dom.stage);
  try {
    const toast = dom.stage.children.find((child) => child.classList.contains('toastp'));
    assert.deepEqual({ tag: toast.tagName, className: toast.className, html: toast.innerHTML }, {
      tag: 'div', className: 'toastp', html: 'Rig the mast done · <b>2 up next</b>',
    });
  } finally {
    hero.teardown();
  }
});
