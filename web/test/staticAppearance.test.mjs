// The Light · Dark toggle the plain HTML pages in public/ carry (scripts/staticAppearance.js, served
// as /appearance.js). Like boot.test.mjs, this drives the EMITTED ES5 against a document just real
// enough for it — the script has no module to import, so the honest test gives it the globals it
// touches and watches what it stores, stamps and repaints.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SEGMENTS, staticAppearanceScript } from '../scripts/staticAppearance.js';
import { checkStaticPage, staticPageAssets } from '../scripts/staticPageAssets.js';
import { KEY } from '../src/shell/appearance.js';

const SCRIPT = staticAppearanceScript(KEY);
const PAGES = new URL('../public/', import.meta.url);
const CHROME = fs.readFileSync(new URL('../scripts/staticPageChrome.css', import.meta.url), 'utf8');
const LIGHT_GROUND = '#F9F5EB';
const DARK_GROUND = '#0B0B0C';

// An element that remembers its attributes, children and listeners; a document with the nav and the
// empty box it opens with, the two metas and the <html> the script stamps; storage and a media
// query the test can drive.
function element(tag, page) {
  return {
    tag, attributes: {}, children: [], listeners: {}, className: '', innerHTML: '', textContent: '', type: '',
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    removeAttribute(name) { delete this.attributes[name]; },
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child, before) {
      const at = this.children.indexOf(before);
      this.children.splice(at < 0 ? this.children.length : at, 0, child);
      return child;
    },
    get firstChild() { return this.children[0] ?? null; },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    fire(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn(event); },
    focus() { page.focused = this; },
  };
}

function page({ stored = null, prefersDark = false, storageThrows = false, box = true } = {}) {
  const state = { focused: null, storage: new Map(stored === null ? [] : [[KEY, stored]]) };
  const html = element('html', state);
  html.style = { props: {}, setProperty(name, value) { this.props[name] = value; }, removeProperty(name) { delete this.props[name]; } };
  const nav = element('span', state);
  const reserved = box ? nav.appendChild(element('span', state)) : null;
  if (reserved) { reserved.className = 'wm-appearance'; reserved.setAttribute('aria-hidden', 'true'); }
  const existing = nav.appendChild(element('a', state));
  const meta = { 'theme-color': element('meta', state), 'color-scheme': element('meta', state) };
  meta['theme-color'].setAttribute('content', LIGHT_GROUND);
  meta['color-scheme'].setAttribute('content', 'light');
  if (prefersDark && stored !== 'light') { html.setAttribute('data-theme', 'dark'); html.setAttribute('data-brand', 'clay'); html.style.setProperty('--wm-boot-ground', DARK_GROUND); }
  const media = { matches: prefersDark, listeners: [], addEventListener(type, fn) { this.listeners.push(fn); } };
  const windowListeners = {};
  const context = {
    document: {
      documentElement: html,
      querySelector: (selector) => (selector === '.navr .wm-appearance' ? reserved : meta[/name="([^"]+)"/.exec(selector)[1]] ?? null),
      createElement: (tag) => element(tag, state),
    },
    localStorage: {
      getItem(key) { if (storageThrows) throw new Error('storage is disabled'); return state.storage.get(key) ?? null; },
      setItem(key, value) { if (storageThrows) throw new Error('storage is disabled'); state.storage.set(key, value); },
    },
    window: {
      matchMedia: (query) => (query.includes('dark') ? media : { matches: false, addEventListener() {} }),
      addEventListener(type, fn) { (windowListeners[type] ??= []).push(fn); },
      // The real ground is the token the stamped <html> resolves; the stub answers the same way, with the whitespace a browser may pad.
      getComputedStyle: () => ({ getPropertyValue: () => ` ${html.getAttribute('data-theme') === 'dark' ? DARK_GROUND : LIGHT_GROUND} ` }),
    },
  };
  vm.createContext(context);
  vm.runInContext(SCRIPT, context);
  const group = reserved;
  const radios = group ? group.children.slice(1) : [];
  return {
    html, nav, existing, group, meta, state,
    radios,
    radio: (label) => radios.find((each) => each.getAttribute('aria-label') === label),
    checked: () => radios.filter((each) => each.getAttribute('aria-checked') === 'true').map((each) => each.getAttribute('aria-label')),
    stored: () => state.storage.get(KEY) ?? null,
    flipSystem(dark) { media.matches = dark; for (const fn of media.listeners) fn({ matches: dark }); },
    otherTab(key, value) {
      if (value === null) state.storage.delete(key); else state.storage.set(key, value);
      for (const fn of windowListeners.storage ?? []) fn({ key });
    },
  };
}

test('every dressed page links /appearance.js deferred, beside /nav-auth.js, and the redirect does not', () => {
  const pages = fs.readdirSync(PAGES).filter((name) => name.endsWith('.html'));
  const linked = pages.filter((name) => fs.readFileSync(new URL(name, PAGES), 'utf8').includes('<script defer src="/appearance.js"></script>'));
  assert.deepEqual(linked.sort(), pages.filter((name) => name !== 'pricing-preview.html').sort());
  for (const name of linked) {
    const html = fs.readFileSync(new URL(name, PAGES), 'utf8');
    assert.ok(html.indexOf('src="/nav-auth.js"') < html.indexOf('src="/appearance.js"'), `${name} links the toggle before the auth pass`);
  }
});

// The gate is what FORCES a new page to carry the toggle: the file goes out through the same map as
// /boot.js, so a page that forgets the link — or the box the script fills — fails the config, not
// the visitor.
test('/appearance.js is emitted by the same asset map as /boot.js, as the script this module builds', () => {
  const emitted = [];
  staticPageAssets().generateBundle.call({ emitFile: (file) => emitted.push(file) });
  const names = emitted.map((file) => file.fileName);
  for (const sheet of ['fonts.css', 'chrome.css', 'boot.js', 'appearance.js']) assert.ok(names.includes(sheet), `${sheet} is not emitted`);
  assert.equal(emitted.find((file) => file.fileName === 'appearance.js').source, SCRIPT);
});

test('the gate refuses a dressed page whose .navr does not open with the empty toggle box', () => {
  const sheets = ['fonts.css', 'chrome.css', 'boot.js', 'appearance.js'];
  const pricing = fs.readFileSync(new URL('pricing.html', PAGES), 'utf8');
  assert.doesNotThrow(() => checkStaticPage('pricing.html', pricing, sheets));
  const boxless = pricing.replace('<span class="wm-appearance" aria-hidden="true"></span>', '');
  assert.throws(() => checkStaticPage('pricing.html', boxless, sheets), /public\/pricing.html does not open .navr with <span class="wm-appearance" aria-hidden="true"><\/span>/);
  const boxLater = pricing.replace('<span class="wm-appearance" aria-hidden="true"></span>\n', '').replace('</span>\n    </header>', '<span class="wm-appearance" aria-hidden="true"></span></span>\n    </header>');
  assert.throws(() => checkStaticPage('pricing.html', boxLater, sheets), /does not open .navr with/, 'a box anywhere but first in .navr is a nav that still slides');
  const unlinked = pricing.replace('<script defer src="/appearance.js"></script>', '');
  assert.throws(() => checkStaticPage('pricing.html', unlinked, sheets), /does not link \/appearance.js/);
});

// The file is served raw to every browser that reaches a static page: no syntax the boot itself avoids.
test('the script is plain ES5 and reads the boot\'s own ladder', () => {
  assert.equal(/\b(const|let|class)\s|=>|`/.test(SCRIPT), false, 'the script uses syntax /boot.js never does');
  assert.ok(SCRIPT.includes(`localStorage.getItem('${KEY}')`));
  assert.ok(SCRIPT.includes("window.matchMedia('(prefers-color-scheme: dark)')"));
});

// The box is already first in .navr, sized by chrome.css: the script fills it in place and prepends
// nothing, so the buttons beside it never move.
test('the toggle fills the box first in .navr as a two-segment radiogroup named Appearance, sun then moon', () => {
  const p = page();
  assert.equal(p.nav.children[0], p.group);
  assert.equal(p.nav.children[1], p.existing, 'the buttons already in the nav stay after the toggle');
  assert.equal(p.nav.children.length, 2, 'nothing was inserted beside the box');
  assert.equal(p.group.attributes['aria-hidden'], undefined, 'the filled box is no longer hidden from assistive tech');
  assert.equal(p.group.attributes.role, 'radiogroup');
  assert.equal(p.group.attributes['aria-label'], 'Appearance');
  assert.equal(p.group.className, 'wm-appearance');
  assert.equal(p.group.children[0].className, 'wm-appearance-thumb');
  assert.deepEqual(p.radios.map((each) => [each.tag, each.type, each.attributes.role, each.attributes['aria-label'], each.attributes['data-value']]), [
    ['button', 'button', 'radio', 'Light', 'light'],
    ['button', 'button', 'radio', 'Dark', 'dark'],
  ]);
  assert.deepEqual(p.radios.map((each) => each.innerHTML), SEGMENTS.map(([, , icon]) => icon));
  assert.ok(p.radio('Light').innerHTML.includes('<circle cx="12" cy="12" r="4"/>'), 'the light segment draws lucide\'s sun');
  assert.ok(p.radio('Dark').innerHTML.includes('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'), 'the dark segment draws lucide\'s moon');
  assert.deepEqual(p.radios.map((each) => each.children[0].textContent), ['Light', 'Dark']);
  assert.deepEqual(p.radios.map((each) => each.children[0].className), ['wm-appearance-word', 'wm-appearance-word']);
});

// The CHECKED segment is the resolved appearance: what the page wears, not what was chosen.
test('with nothing stored the check follows the device; a stored choice wins; "system" counts as nothing', () => {
  assert.deepEqual(page({ prefersDark: true }).checked(), ['Dark']);
  assert.deepEqual(page({ prefersDark: false }).checked(), ['Light']);
  assert.deepEqual(page({ stored: 'system', prefersDark: true }).checked(), ['Dark']);
  assert.deepEqual(page({ stored: 'light', prefersDark: true }).checked(), ['Light']);
  assert.deepEqual(page({ stored: 'dark', prefersDark: false }).checked(), ['Dark']);
  assert.deepEqual(page({ stored: 'nonsense', prefersDark: false }).checked(), ['Light']);
  const p = page({ prefersDark: true });
  assert.equal(p.group.attributes['data-resolved'], 'dark');
  assert.deepEqual(p.radios.map((each) => each.attributes.tabindex), ['-1', '0'], 'one tab stop, on the checked segment');
  assert.equal(p.stored(), null, 'mounting stores nothing — the page keeps following the device');
});

test('picking Dark stores dark, stamps <html> and tells the browser chrome the night ground', () => {
  const p = page();
  p.radio('Dark').fire('click');
  assert.equal(p.stored(), 'dark');
  assert.deepEqual(p.html.attributes, { 'data-theme': 'dark', 'data-brand': 'clay' });
  assert.deepEqual(p.checked(), ['Dark']);
  assert.equal(p.group.attributes['data-resolved'], 'dark');
  assert.deepEqual(p.radios.map((each) => each.attributes.tabindex), ['-1', '0']);
  assert.deepEqual(p.meta['theme-color'].attributes, { content: DARK_GROUND, 'data-was': LIGHT_GROUND });
  assert.deepEqual(p.meta['color-scheme'].attributes, { content: 'dark', 'data-was': 'light' });
});

// Absence of data-theme is light: the stamp is removed, never set to "light", and the pre-CSS ground
// the boot parked inline goes with it, as the landings' cleanup does.
test('picking Light stores light and un-stamps <html>, handing the chrome the day ground', () => {
  const p = page({ stored: 'dark', prefersDark: true });
  assert.deepEqual(p.html.style.props, { '--wm-boot-ground': DARK_GROUND });
  p.radio('Light').fire('click');
  assert.equal(p.stored(), 'light');
  assert.deepEqual(p.html.attributes, {});
  assert.deepEqual(p.html.style.props, {});
  assert.deepEqual(p.checked(), ['Light']);
  assert.equal(p.meta['theme-color'].attributes.content, LIGHT_GROUND);
  assert.equal(p.meta['color-scheme'].attributes.content, 'light');
});

// Following the device and having chosen what the device says look the same — until sunset.
test('picking the segment already checked still turns the device\'s side into a stored choice', () => {
  const p = page({ prefersDark: true });
  p.radio('Dark').fire('click');
  assert.equal(p.stored(), 'dark');
  p.flipSystem(false);
  assert.deepEqual(p.checked(), ['Dark'], 'an explicit choice does not move with the device');
  assert.equal(p.html.attributes['data-theme'], 'dark');
});

test('while nothing is stored a device flip moves the check and the stamp; a stored choice ignores it', () => {
  const p = page({ prefersDark: false });
  p.flipSystem(true);
  assert.deepEqual(p.checked(), ['Dark']);
  assert.equal(p.html.attributes['data-theme'], 'dark');
  assert.equal(p.meta['color-scheme'].attributes.content, 'dark');
  p.flipSystem(false);
  assert.deepEqual(p.checked(), ['Light']);
  assert.deepEqual(p.html.attributes, {});
  assert.equal(p.stored(), null);
  const pinned = page({ stored: 'light', prefersDark: false });
  pinned.flipSystem(true);
  assert.deepEqual(pinned.checked(), ['Light']);
  assert.deepEqual(pinned.html.attributes, {});
});

test('a choice made in another tab reaches this page through storage, and a cleared one hands it back to the device', () => {
  const p = page({ prefersDark: false });
  p.otherTab(KEY, 'dark');
  assert.deepEqual(p.checked(), ['Dark']);
  assert.equal(p.html.attributes['data-theme'], 'dark');
  p.otherTab('windmill:auth-hint', '{}');
  assert.deepEqual(p.checked(), ['Dark'], 'an unrelated key is not a switch');
  p.otherTab(KEY, null);
  assert.deepEqual(p.checked(), ['Light']);
  assert.deepEqual(p.html.attributes, {});
});

test('arrow keys move the choice between the two and carry focus with it, wrapping either way', () => {
  const p = page();
  const prevented = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  let event = prevented();
  p.radio('Light').fire('keydown', { key: 'ArrowRight', ...event });
  assert.deepEqual(p.checked(), ['Dark']);
  assert.equal(p.stored(), 'dark');
  assert.equal(p.state.focused, p.radio('Dark'));
  p.radio('Dark').fire('keydown', { key: 'ArrowRight', ...prevented() });
  assert.deepEqual(p.checked(), ['Light'], 'right from the last wraps to the first');
  p.radio('Light').fire('keydown', { key: 'ArrowLeft', ...prevented() });
  assert.deepEqual(p.checked(), ['Dark'], 'left from the first wraps to the last');
  p.radio('Dark').fire('keydown', { key: 'Home', ...prevented() });
  assert.deepEqual(p.checked(), ['Light']);
  p.radio('Light').fire('keydown', { key: 'End', ...prevented() });
  assert.deepEqual(p.checked(), ['Dark']);
  event = prevented();
  p.radio('Dark').fire('keydown', { key: 'Tab', ...event });
  assert.deepEqual(p.checked(), ['Dark'], 'Tab leaves the bar alone');
  assert.equal(event.prevented, false);
});

test('a page without the box and a browser without storage both cost nothing', () => {
  const bare = page({ box: false });
  assert.equal(bare.group, null);
  assert.deepEqual(bare.nav.children, [bare.existing], 'nothing is mounted where no box was reserved');
  assert.deepEqual(bare.html.attributes, {});
  const locked = page({ storageThrows: true, prefersDark: true });
  assert.deepEqual(locked.checked(), ['Dark']);
  locked.radio('Light').fire('click');
  assert.deepEqual(locked.checked(), ['Light'], 'the pick still applies for this page');
  assert.deepEqual(locked.html.attributes, {});
});

// The same discipline boot.test.mjs holds the chrome to: the toggle's rules name tokens, never a
// colour of their own, and under 480px the word goes while the aria-label stays on the button.
test('the toggle\'s chrome is token-valued and hides the word, not the name, on a phone', () => {
  const rules = CHROME.slice(CHROME.indexOf('.wm-appearance'));
  assert.ok(rules.length > 0, 'staticPageChrome.css carries no .wm-appearance rules');
  assert.equal(/#[0-9A-Fa-f]{3,8}\b|rgba?\(/.test(rules), false, 'the toggle names a colour instead of a token');
  for (const token of ['--surface-sunken', '--surface-card', '--border-subtle', '--text-primary', '--text-tertiary', '--text-link']) {
    assert.ok(rules.includes(`var(${token})`), `${token} is not used`);
  }
  assert.match(rules, /\.wm-appearance \{[^}]*min-width: 138px;[^}]*height: 32px/, 'the empty box must already be the filled pill\'s size');
  assert.match(rules, /@media \(max-width: 479px\) \{[^}]*\.wm-appearance \{ min-width: 70px; \}/);
  assert.match(rules, /font-size: var\(--text-xs\)/);
  assert.match(rules, /focus-visible \{ box-shadow: var\(--focus-ring\); \}/);
  for (const token of ['--text-xs', '--focus-ring']) assert.ok(CHROME.includes(`${token}:`), `${token} is used but chrome.css never defines it`);
  assert.match(rules, /@media \(max-width: 479px\) \{[^\n]*\.wm-appearance-word \{ display: none; \}/);
  assert.match(rules, /\.wm-appearance\[data-resolved="dark"\] \.wm-appearance-thumb \{ transform: translateX/);
  assert.equal(SCRIPT.includes("setAttribute('aria-label',label)"), true, 'the word on the button survives its label being hidden');
});
