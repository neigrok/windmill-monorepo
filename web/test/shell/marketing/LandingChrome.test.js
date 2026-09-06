// A landing at night stamps <html> the way the boot does, and takes it all back when it unmounts;
// by day it leaves <html> alone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadScreen, renderHook } from '../../products/gym/harness.mjs';

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
