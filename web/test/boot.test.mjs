// The boot that decides what an app room looks like before React exists (scripts/appBoot.js).
// Everything here is the part that can be wrong SILENTLY: a ground that drifts from the palette it
// was read out of, a room the registry opened and the boot never learned about, and the one line
// that keeps this script off every page that is not an app room.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { readGrounds, readLandings, bootScript, staticBootScript, BOOT_STYLE } from '../scripts/appBoot.js';
import { PRODUCTS } from '../src/shell/products.js';
import { KEY } from '../src/shell/appearance.js';

const read = (file) => fs.readFileSync(new URL(`../src/styles/tokens/${file}`, import.meta.url), 'utf8');
const BRANDS = ['clay', ...new Set(PRODUCTS.map((product) => product.shell.scope.brand))];
const grounds = readGrounds(read('colors.css'), read('palettes.css'), BRANDS);

// The rooms the boot will really be built with, and the script it will really emit. Everything
// below drives THAT text rather than reading the source that produces it — the boot is seven lines
// of ES5 against a handful of browser globals, so the honest test is to give it those globals and
// watch what it does.
const ROOMS = PRODUCTS
  .filter((product) => product.shell.status === 'open')
  .map((product) => ({
    path: product.shell.room,
    brand: product.shell.scope.brand,
    theme: product.shell.scope.theme ?? null,
    assets: [`/assets/${product.id}.js`, `/assets/${product.id}.css`],
  }));
const SCRIPT = bootScript(ROOMS, readLandings(PRODUCTS), grounds, ['/assets/Shell.js'], KEY);
const STATIC = staticBootScript(readGrounds(read('colors.css'), read('palettes.css'), ['clay']), KEY);

// A document just real enough for the boot: the two metas it rewrites, an element that remembers
// its attributes and inline custom properties, and a head that collects appended links.
function boot(pathname, { stored = null, prefersDark = false, storageThrows = false, script = SCRIPT } = {}) {
  const tag = (content) => ({
    content,
    was: null,
    setAttribute(name, value) { if (name === 'content') this.content = value; else if (name === 'data-was') this.was = value; },
    getAttribute(name) { return name === 'data-was' ? this.was : null; },
  });
  const meta = { 'theme-color': tag('#F9F5EB'), 'color-scheme': tag('light') };
  const html = {
    attributes: {},
    style: { props: {}, setProperty(name, value) { this.props[name] = value; } },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
  const links = [];
  const context = {
    location: { pathname },
    document: {
      documentElement: html,
      head: { appendChild: (link) => links.push(link) },
      querySelector: (selector) => meta[/name="([^"]+)"/.exec(selector)[1]] ?? null,
      createElement: () => ({}),
    },
    localStorage: {
      getItem: (key) => {
        if (storageThrows) throw new Error('storage is disabled in this browser');
        return key === KEY ? stored : null;
      },
    },
    window: { matchMedia: (query) => ({ matches: query.includes('dark') && prefersDark }) },
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return { attributes: html.attributes, ground: html.style.props['--wm-boot-ground'], meta, links };
}

// The whole point of reading palettes.css instead of retyping it. These are the values the design
// canon names each room by — Tuscany and the family night, paper in north light and the ink-cast
// night, pietra and the instrument — and if a palette is tuned and this test is not, it is the TEST that is stale, not the
// boot: re-read the block that moved and change the expectation to what it now says.
test('every room boots on the ground its own palette block declares', () => {
  assert.deepEqual(grounds, {
    'light|clay': '#F9F5EB',
    'light|roadmap': '#F9F5EB',
    'light|journal': '#F7F7F5',
    'light|gym': '#EBE7E3',
    'dark|clay': '#0B0B0C',
    'dark|roadmap': '#0B0B0C',
    'dark|journal': '#0B0E16',
    'dark|gym': '#110C10',
  });
});

// A room whose ground came back as the family default when its palette says otherwise is the exact
// failure this whole wave exists to stop — a dark room opening on a light colour.
test('no room silently falls back to the family cream', () => {
  const inherited = Object.entries(grounds)
    .filter(([pair, hex]) => pair.startsWith('dark|') && hex === grounds['light|clay'])
    .map(([pair]) => pair);
  assert.deepEqual(inherited, []);
});

// The boot names no product: it reads the rooms off the registry the router composes. This is what
// makes a fourth product boot correctly on the day it opens, without anyone remembering this file.
// (That the module it names is really on disk is shell-boundaries' — it checks the landing's twin.)
test('every open product names a room and a brand with a ground of its own', () => {
  const open = PRODUCTS.filter((product) => product.shell.status === 'open');
  assert.ok(open.length > 0, 'no product is open — the registry cannot be right');

  const wrong = open.flatMap((product) => {
    const { room, scope, module } = product.shell;
    const complaints = [];
    if (!room?.startsWith('/app/')) complaints.push(`${product.id} claims the room "${room}", which is not under /app/`);
    if (!(`light|${scope.brand}` in grounds)) complaints.push(`${product.id} claims the brand "${scope.brand}", which has no ground in palettes.css`);
    if (!module) complaints.push(`${product.id} names no shell.module, so the boot would preload nothing for its room`);
    return complaints;
  });
  assert.deepEqual(wrong, []);
});

// A room that PINS its skin must boot in it. Gym is the instrument whatever the device prefers,
// and the boot reads that pin from the same registry line the shell does — so the one room where a
// stored 'light' would be wrong is the one room that never reads it.
test('a pinned room boots in its pin, and an unpinned one is left to the device', () => {
  const pinned = PRODUCTS.filter((product) => product.shell.scope.theme);
  const following = PRODUCTS.filter((product) => !product.shell.scope.theme);
  assert.deepEqual(pinned.map((p) => [p.id, p.shell.scope.theme]), [['gym', 'dark']]);
  assert.deepEqual(following.map((p) => p.id), ['roadmap', 'journal']);
});

// index.html is not only the app's document. It is every /t/:id share page — the backend splices a
// shared tree's meta into these very bytes — and every path the router answers with something that
// is neither a room nor a landing. On those the boot has exactly one job: nothing at all.
test('the boot leaves every page that is neither a room nor a landing alone', () => {
  for (const pathname of ['/t/t_abc', '/gallery', '/appfoo', '/apple-touch-icon.png', '/application', '/journal/2026-07-20', '/journalism', '/pricing']) {
    const { attributes, ground, meta, links } = boot(pathname, { prefersDark: true });
    assert.deepEqual(attributes, {}, `${pathname} was stamped`);
    assert.equal(ground, undefined, `${pathname} was given a boot ground`);
    assert.equal(meta['theme-color'].content, '#F9F5EB', `${pathname} had its theme-color rewritten`);
    assert.equal(meta['color-scheme'].content, 'light', `${pathname} had its color-scheme rewritten`);
    assert.deepEqual(links, [], `${pathname} was given preloads`);
  }
});

// The landings follow the same choice the rooms do — a visitor who chose dark must not be shown a
// cream hero on the way back to the brand root. The brand root is clay; a product's landing wears
// the product, as its room does. Nothing is preloaded: the landing shells name their own chunks.
test('the brand root and every open landing boot dark on their own ground when dark was chosen', () => {
  const landings = readLandings(PRODUCTS);
  assert.deepEqual(landings, [
    { path: '/', brand: 'clay' },
    { path: '/roadmap', brand: 'roadmap' },
    { path: '/journal', brand: 'journal' },
    { path: '/gym', brand: 'gym' },
  ]);
  for (const { path, brand } of landings) {
    for (const pathname of [path, path === '/' ? '/' : `${path}/`]) {
      const night = boot(pathname, { stored: 'dark' });
      assert.deepEqual(night.attributes, { 'data-wm-boot': 'landing', 'data-theme': 'dark', 'data-brand': brand }, pathname);
      assert.equal(night.ground, grounds[`dark|${brand}`], `${pathname} did not boot on its dark ground`);
      assert.equal(night.meta['theme-color'].content, grounds[`dark|${brand}`]);
      assert.equal(night.meta['color-scheme'].content, 'dark');
      assert.deepEqual(night.links, [], `${pathname} was given preloads`);
    }
  }
  assert.equal(boot('/', { stored: null, prefersDark: true }).attributes['data-theme'], 'dark', 'a landing with no stored choice asks the device');
});

// A landing by day is the landing as it was before the boot existed: its root stamps nothing by
// day, and neither may <html> — a product brand on <html> in the light would fire that room's
// light ground (paper, pietra) across the whole page. The boot flag alone is stamped.
test('a landing by day is flagged as booting and nothing else', () => {
  for (const { path, brand } of readLandings(PRODUCTS)) {
    for (const options of [{ stored: 'light', prefersDark: true }, { stored: 'system', prefersDark: false }, { stored: null }]) {
      const day = boot(path, options);
      assert.deepEqual(day.attributes, { 'data-wm-boot': 'landing' }, `${path} (${brand}) was stamped by day`);
      assert.equal(day.ground, undefined, `${path} was given a ground by day`);
      assert.equal(day.meta['theme-color'].content, '#F9F5EB');
      assert.equal(day.meta['color-scheme'].content, 'light');
      assert.equal(day.meta['theme-color'].getAttribute('data-was'), null, 'a meta that was not rewritten must not claim it was');
    }
  }
});

// The plain HTML pages in public/ carry the same ladder as /boot.js (scripts/staticPageAssets.js),
// with no path table: every one of them is a neutral page, clay when the night was chosen and
// untouched by day.
test('a static page boots clay at night, and is only flagged by day', () => {
  const night = boot('/pricing.html', { stored: 'dark', script: STATIC });
  assert.deepEqual(night.attributes, { 'data-wm-boot': 'static', 'data-theme': 'dark', 'data-brand': 'clay' });
  assert.equal(night.ground, grounds['dark|clay']);
  assert.equal(night.meta['theme-color'].content, grounds['dark|clay']);
  assert.equal(night.meta['color-scheme'].content, 'dark');
  const day = boot('/terms.html', { stored: null, prefersDark: false, script: STATIC });
  assert.deepEqual(day.attributes, { 'data-wm-boot': 'static' });
  assert.equal(day.ground, undefined);
  assert.equal(day.meta['theme-color'].content, '#F9F5EB');
  assert.equal(boot('/privacy.html', { storageThrows: true, prefersDark: true, script: STATIC }).attributes['data-theme'], 'dark');
});

// Every dressed page links the stamp (pricing-preview.html is an undressed redirect), and the sheet
// it dresses in answers the stamp with a night: a dark block that really re-points the ground, the
// ink and the brand, not just a selector with the right name.
test('every static page links /boot.js and chrome.css carries both themes', () => {
  const pages = fs.readdirSync(new URL('../public/', import.meta.url)).filter((name) => name.endsWith('.html') && name !== 'pricing-preview.html');
  const unlinked = pages.filter((page) => !fs.readFileSync(new URL(`../public/${page}`, import.meta.url), 'utf8').includes('<script src="/boot.js"></script>'));
  assert.deepEqual(unlinked, []);
  const chrome = fs.readFileSync(new URL('../scripts/staticPageChrome.css', import.meta.url), 'utf8');
  const night = /html\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(chrome)?.[1] ?? '';
  const day = /:root\s*\{([^}]*)\}/.exec(chrome)?.[1] ?? '';
  for (const token of ['--surface-canvas', '--text-primary', '--color-brand']) {
    const at = (block) => new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6}|rgba?\\([^)]*\\))`).exec(block)?.[1] ?? null;
    assert.ok(at(night), `${token} is not declared in the dark block`);
    assert.ok(at(day), `${token} is not declared at :root`);
    assert.notEqual(at(night), at(day), `${token} is the same colour by night as by day`);
  }
  assert.ok(chrome.includes('html[data-wm-boot] { background: var(--surface-canvas, var(--wm-boot-ground)); }'));
  assert.equal(/#[0-9A-Fa-f]{6}\b/.test(chrome.slice(chrome.indexOf('html[data-wm-boot]'))), false, 'the chrome rules name a colour of their own instead of a token');
});

// The sentinels the backend's share-page rewriter keys on, in the file the boot is injected into.
test('index.html still carries both unfurl sentinels', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal(html.split('<!-- meta:unfurl:start -->').length - 1, 1);
  assert.equal(html.split('<!-- meta:unfurl:end -->').length - 1, 1);
});

// A room is a PREFIX: /app/journal/2026-07-20 is a day in the canvas and /app/gym/shared/<token> is
// somebody's shared workout, and both are still that room. The bare /app and the account surfaces are
// nobody's product, so they wear the family clay.
test('a room claims its own deep paths, and only those', () => {
  assert.equal(boot('/app/journal').attributes['data-brand'], 'journal');
  assert.equal(boot('/app/journal/2026-07-20').attributes['data-brand'], 'journal');
  assert.equal(boot('/app/roadmap/t_abc').attributes['data-brand'], 'roadmap');
  assert.equal(boot('/app').attributes['data-brand'], 'clay');
  assert.equal(boot('/app/settings').attributes['data-brand'], 'clay');
  assert.equal(boot('/app/connect').attributes['data-brand'], 'clay');
  // Not a room, and not journal either: a prefix match must stop at the separator.
  assert.equal(boot('/app/journalism').attributes['data-brand'], 'clay');
});

// Every app room is stamped as one, whatever else it decides.
test('every app room is flagged as booting, and as a room rather than a landing', () => {
  for (const pathname of ['/app', '/app/roadmap', '/app/journal', '/app/gym', '/app/settings']) {
    assert.equal(boot(pathname).attributes['data-wm-boot'], 'app', `${pathname} was not flagged`);
  }
});

// The ladder appearance.js states, restated where it has to run before any module does: an explicit
// choice wins, anything else asks the device, and a device that will not answer reads as light.
test('an unpinned room reads the stored choice, then the device, then light', () => {
  assert.equal(boot('/app/journal', { stored: 'dark' }).attributes['data-theme'], 'dark');
  assert.equal(boot('/app/journal', { stored: 'light', prefersDark: true }).attributes['data-theme'], 'light',
    'an explicit light must not move when the machine flips at sunset');
  assert.equal(boot('/app/journal', { stored: 'system', prefersDark: true }).attributes['data-theme'], 'dark');
  assert.equal(boot('/app/journal', { stored: null, prefersDark: true }).attributes['data-theme'], 'dark');
  assert.equal(boot('/app/journal', { stored: null, prefersDark: false }).attributes['data-theme'], 'light');
  assert.equal(boot('/app/journal', { stored: 'nonsense', prefersDark: false }).attributes['data-theme'], 'light');
});

// The one room where a stored choice would be wrong is the one room that never reads it.
test('a pinned room ignores the stored choice and the device alike', () => {
  for (const options of [{ stored: 'light' }, { stored: 'system', prefersDark: false }, { stored: null }]) {
    const { attributes, ground } = boot('/app/gym', options);
    assert.equal(attributes['data-theme'], 'dark');
    assert.equal(ground, grounds['dark|gym']);
  }
});

// A blocking script in <head> that throws takes the whole page with it, and the browsers that
// refuse storage are exactly the private windows people open at night.
test('storage that throws costs the room nothing but the stored choice', () => {
  const { attributes, ground } = boot('/app/journal', { storageThrows: true, prefersDark: true });
  assert.equal(attributes['data-theme'], 'dark');
  assert.equal(attributes['data-brand'], 'journal');
  assert.equal(ground, grounds['dark|journal']);
});

// The browser is told the ground twice: once to paint with before the stylesheet exists, once so
// its own chrome matches the room instead of the cream it was going to use.
test('the ground and the chrome agree with the room', () => {
  const { ground, meta } = boot('/app/journal', { stored: 'dark' });
  assert.equal(ground, '#0B0E16');
  assert.equal(meta['theme-color'].content, '#0B0E16');
  assert.equal(meta['color-scheme'].content, 'dark');
});

// Leaving a room is not always a document load, so what the boot overwrote has to be recoverable.
// It parks the old value on the meta itself rather than telling the shell a colour — a phone left
// wearing journal-night in its address bar over the cream brand root is a lie held, not flashed.
test('the boot keeps what it replaced so the shell can hand it back', () => {
  const { meta } = boot('/app/journal', { stored: 'dark' });
  assert.equal(meta['theme-color'].getAttribute('data-was'), '#F9F5EB');
  assert.equal(meta['color-scheme'].getAttribute('data-was'), 'light');
});

// The whole reason the room is known this early: its chunks go out in the first flight instead of
// being discovered two round trips later.
test('a room preloads its own assets, and the neutral rooms preload the shell', () => {
  assert.deepEqual(boot('/app/journal').links.map((link) => [link.rel, link.href]), [
    ['modulepreload', '/assets/journal.js'],
    ['preload', '/assets/journal.css'],
  ]);
  assert.deepEqual(boot('/app').links.map((link) => [link.rel, link.href]), [['modulepreload', '/assets/Shell.js']]);
  assert.equal(boot('/app/journal').links[1].as, 'style', 'a stylesheet preloaded as a script is fetched twice');
});

// The ground is handed over as a custom-property FALLBACK on purpose. An inline background would
// win over the stylesheet forever, so switching rooms without a reload would leave the first room's
// colour welded to <html> behind every room after it.
test('the pre-CSS ground yields to the token the moment the stylesheet lands', () => {
  assert.ok(BOOT_STYLE.includes('html[data-wm-boot]{background:var(--surface-canvas,var(--wm-boot-ground))}'));
  assert.ok(!/documentElement\.style\.background\s*=/.test(SCRIPT),
    'the boot sets an inline background again, which no stylesheet can take back');
});

// Only an app room has a bundle coming to mount over the fallback body. A landing shell carries that
// landing's own body for a crawler without JavaScript, and a static page IS its body; the boot flags
// both, and must not hide either.
test('the boot hides the no-JS body in an app room and nowhere else', () => {
  const hides = [...BOOT_STYLE.matchAll(/([^{}]+)\{[^}]*display:none[^}]*\}/g)].map((hit) => hit[1].trim());
  assert.deepEqual(hides, ['html[data-wm-boot="app"] #root>main']);
});
