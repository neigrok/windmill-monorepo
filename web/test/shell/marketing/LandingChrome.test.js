// A landing at night stamps <html> the way the boot does, and takes it all back when it unmounts;
// by day it leaves <html> alone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { elementsOf, loadScreen, renderHook, textOf } from '../../products/gym/harness.mjs';

function browser({ ground }) {
  const query = { matches: false, addEventListener() {}, removeEventListener() {} };
  globalThis.window = { matchMedia: () => query, addEventListener() {}, removeEventListener() {} };
  const meta = (content) => ({
    content,
    dataset: {},
    getAttribute(name) { return name === 'content' ? this.content : this.dataset[name.slice(5)] ?? null; },
    setAttribute(name, value) { if (name === 'content') this.content = value; else this.dataset[name.slice(5)] = value; },
  });
  const metas = { 'theme-color': meta('#F9F5EB'), 'color-scheme': meta('light') };
  const html = {
    attributes: {},
    style: { props: {}, setProperty(name, value) { this.props[name] = value; }, removeProperty(name) { delete this.props[name]; } },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
  };
  globalThis.document = {
    documentElement: html,
    querySelector: (selector) => metas[/meta\[name="([^"]+)"\]/.exec(selector)?.[1]] ?? null,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => ground });
  return { html, metas };
}

const DOOR = { open() {}, lendHost() {} };

test('at night the landing stamps <html> with theme, brand, ground and the two metas, and unstamps on unmount', async (t) => {
  const { html, metas } = browser({ ground: '#0B0E16' });
  const { setAppearance } = await loadScreen('shell/appearance.js');
  const { LandingPage } = await loadScreen('shell/marketing/LandingChrome.jsx');
  setAppearance('dark');

  const view = renderHook(t, () => LandingPage({ brand: 'journal', product: 'journal', children: null }), { context: DOOR });
  assert.deepEqual(html.attributes, { 'data-theme': 'dark', 'data-brand': 'journal' });
  assert.deepEqual(html.style.props, { '--wm-boot-ground': '#0B0E16' });
  assert.deepEqual([metas['theme-color'].content, metas['theme-color'].dataset.was], ['#0B0E16', '#F9F5EB']);
  assert.deepEqual([metas['color-scheme'].content, metas['color-scheme'].dataset.was], ['dark', 'light']);

  view.unmount();
  assert.deepEqual(html.attributes, {});
  assert.deepEqual(html.style.props, {});
  assert.equal(metas['theme-color'].content, '#F9F5EB');
  assert.equal(metas['color-scheme'].content, 'light');
  setAppearance('system');
});

test('by day the landing leaves <html> and the metas untouched', async (t) => {
  const { html, metas } = browser({ ground: '#F7F7F5' });
  const { setAppearance } = await loadScreen('shell/appearance.js');
  const { LandingPage } = await loadScreen('shell/marketing/LandingChrome.jsx');
  setAppearance('light');

  renderHook(t, () => LandingPage({ brand: 'journal', product: 'journal', children: null }), { context: DOOR });
  assert.deepEqual(html.attributes, {});
  assert.deepEqual(html.style.props, {});
  assert.deepEqual([metas['theme-color'].content, metas['color-scheme'].content], ['#F9F5EB', 'light']);
  assert.deepEqual(metas['theme-color'].dataset, {});
  setAppearance('system');
});

test('the brand root wears clay at night', async (t) => {
  const { html } = browser({ ground: '#0B0B0C' });
  const { setAppearance } = await loadScreen('shell/appearance.js');
  const { LandingPage } = await loadScreen('shell/marketing/LandingChrome.jsx');
  setAppearance('dark');
  renderHook(t, () => LandingPage({ brand: null, product: null, children: null }), { context: DOOR });
  assert.deepEqual(html.attributes, { 'data-theme': 'dark', 'data-brand': 'clay' });
  setAppearance('system');
});

// ---- the appearance toggle in the nav ----
// The Light · Dark bar opens the cluster on every landing — signed in, signed out, and while auth
// is still unanswered — and the seat is told to draw no Appearance row of its own.

const renderNamed = (t, tree, name, context) => {
  const element = elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === name);
  assert.ok(element, `${name} is in the tree`);
  return renderHook(t, () => element.type(element.props), { context }).tree;
};

const cluster = async (t, { product, status, user }) => {
  const { LandingPage } = await loadScreen('shell/marketing/LandingChrome.jsx');
  const { AppearanceToggle } = await loadScreen('shell/marketing/AppearanceToggle.jsx');
  const { AccountSeat } = await loadScreen('shell/auth/AccountSeat.jsx');
  const context = { ...DOOR, status, user, signOut() {} };
  const page = renderHook(t, () => LandingPage({ brand: product, product, cta: { href: '/x', label: 'Open' }, children: null }), { context });
  const nav = renderNamed(t, page.tree, 'LandingNav', context);
  const tree = renderNamed(t, nav, 'NavCluster', context);
  const children = elementsOf(tree)[0].props.children.flat().filter(Boolean);
  return { page, tree, kinds: children.map((each) => (each.type === AppearanceToggle ? 'toggle' : each.type === AccountSeat ? 'seat' : each.type)), seat: children.find((each) => each.type === AccountSeat) };
};

test('the toggle opens the cluster on every landing, signed in and out, and the seat draws no row', async (t) => {
  browser({ ground: '#F7F7F5' });
  const { PRODUCTS } = await loadScreen('shell/products.js');
  const { setAppearance } = await loadScreen('shell/appearance.js');
  setAppearance('system');
  const visitors = [
    { status: 'ghost', user: null },
    { status: 'signed-in', user: { name: 'Ada', email: 'ada@example.com' } },
  ];
  for (const product of [null, ...PRODUCTS.map((entry) => entry.id)]) {
    for (const visitor of visitors) {
      const { kinds, seat } = await cluster(t, { product, ...visitor });
      assert.equal(kinds[0], 'toggle', `${product ?? 'root'} ${visitor.status}: first in the cluster`);
      assert.equal(kinds.at(-1), 'seat', `${product ?? 'root'} ${visitor.status}: the seat closes it`);
      assert.equal(kinds.filter((kind) => kind === 'toggle').length, 1, `${product ?? 'root'} ${visitor.status}: one toggle`);
      assert.equal(seat.props.appearance, false, `${product ?? 'root'} ${visitor.status}: the seat draws no Appearance row on a landing`);
    }
  }
});

test('picking Dark in the nav stores dark and stamps <html> at once', async (t) => {
  const { html } = browser({ ground: '#0B0E16' });
  const disk = new Map();
  globalThis.localStorage = { getItem: (key) => disk.get(key) ?? null, setItem: (key, value) => disk.set(key, value), removeItem: (key) => disk.delete(key) };
  const { setAppearance } = await loadScreen('shell/appearance.js');
  setAppearance('system');
  disk.clear();

  const { page, tree } = await cluster(t, { product: 'journal', status: 'ghost', user: null });
  assert.deepEqual(html.attributes, {}, 'nothing stored and a light device: by day <html> is untouched');
  // The toggle and the bar it draws, rendered as one so a redraw reaches both.
  const toggle = renderHook(t, () => {
    const element = elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'AppearanceToggle');
    const bar = elementsOf(element.type(element.props)).find((each) => typeof each.type === 'function');
    return bar.type(bar.props);
  });
  const radio = (word) => elementsOf(toggle.tree).find((each) => each.props.role === 'radio' && textOf(each) === word);
  assert.deepEqual([radio('Light').props['aria-checked'], radio('Dark').props['aria-checked']], [true, false]);

  radio('Dark').props.onClick();
  assert.equal(disk.get('windmill:appearance'), 'dark');
  toggle.redraw();
  page.redraw();
  assert.deepEqual([radio('Light').props['aria-checked'], radio('Dark').props['aria-checked']], [false, true]);
  assert.deepEqual(html.attributes, { 'data-theme': 'dark', 'data-brand': 'journal' });
  setAppearance('system');
  delete globalThis.localStorage;
});

test('while auth is unanswered the toggle is already there and first; only the seat waits', async (t) => {
  browser({ ground: '#F7F7F5' });
  const { setAppearance } = await loadScreen('shell/appearance.js');
  setAppearance('system');
  const { tree, kinds } = await cluster(t, { product: 'gym', status: 'loading', user: null });
  assert.equal(kinds[0], 'toggle');
  assert.equal(kinds.includes('seat'), false);
  const hidden = elementsOf(tree).find((each) => each.props['aria-hidden'] === 'true');
  assert.deepEqual(hidden.props.style, { display: 'contents', visibility: 'hidden' }, 'the buttons keep their box invisibly');
  assert.equal(elementsOf(hidden).some((each) => each.type?.name === 'AppearanceToggle'), false, 'the toggle is not in the hidden part');
});
