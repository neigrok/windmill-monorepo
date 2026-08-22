// The boot that decides what an app room looks like before React exists (scripts/appBoot.js).
// Everything here is the part that can be wrong SILENTLY: a ground that drifts from the palette it
// was read out of, a room the registry opened and the boot never learned about, and the one line
// that keeps this script off every page that is not an app room.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { readGrounds, bootScript, BOOT_STYLE } from '../scripts/appBoot.js';
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
const SCRIPT = bootScript(ROOMS, grounds, ['/assets/Shell.js'], KEY);

// A document just real enough for the boot: the two metas it rewrites, an element that remembers
// its attributes and inline custom properties, and a head that collects appended links.
function boot(pathname, { stored = null, prefersDark = false, storageThrows = false } = {}) {
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
  vm.runInContext(SCRIPT, context);
  return { attributes: html.attributes, ground: html.style.props['--wm-boot-ground'], meta, links };
}

// The whole point of reading palettes.css instead of retyping it. These are the values the design
// canon names each room by — Tuscany and its embers, paper in north light and dusk, pietra and
// basalt — and if a palette is tuned and this test is not, it is the TEST that is stale, not the
// boot: re-read the block that moved and change the expectation to what it now says.
test('every room boots on the ground its own palette block declares', () => {
  assert.deepEqual(grounds, {
    'light|clay': '#F9F5EB',
    'light|roadmap': '#F9F5EB',
    'light|journal': '#F7F7F5',
    'light|gym': '#EBE7E3',
    'dark|clay': '#0D0B07',
    'dark|roadmap': '#1C1712',
    'dark|journal': '#040D19',
    'dark|gym': '#1C1A1E',
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

// A room that PINS its skin must boot in it. Gym's instrument is basalt whatever the device prefers,
// and the boot reads that pin from the same registry line the shell does — so the one room where a
// stored 'light' would be wrong is the one room that never reads it.
test('a pinned room boots in its pin, and an unpinned one is left to the device', () => {
  const pinned = PRODUCTS.filter((product) => product.shell.scope.theme);
  const following = PRODUCTS.filter((product) => !product.shell.scope.theme);
  assert.deepEqual(pinned.map((p) => [p.id, p.shell.scope.theme]), [['gym', 'dark']]);
  assert.deepEqual(following.map((p) => p.id), ['roadmap', 'journal']);
});

// index.html is not only the app's document. It is the three landing shells, and it is every
// /t/:id share page — the backend splices a shared tree's meta into these very bytes. So the boot
// has exactly one job outside /app: nothing at all, on every shape that is not a room.
test('the boot leaves every page that is not an app room alone', () => {
  for (const pathname of ['/', '/journal', '/gym', '/roadmap', '/t/t_abc', '/gallery', '/appfoo', '/apple-touch-icon.png', '/application']) {
    const { attributes, ground, meta, links } = boot(pathname, { prefersDark: true });
    assert.deepEqual(attributes, {}, `${pathname} was stamped as an app room`);
    assert.equal(ground, undefined, `${pathname} was given a boot ground`);
    assert.equal(meta['theme-color'].content, '#F9F5EB', `${pathname} had its theme-color rewritten`);
    assert.equal(meta['color-scheme'].content, 'light', `${pathname} had its color-scheme rewritten`);
    assert.deepEqual(links, [], `${pathname} was given preloads`);
  }
});

// The sentinels the backend's share-page rewriter keys on, in the file the boot is injected into.
test('index.html still carries both unfurl sentinels', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.equal(html.split('<!-- meta:unfurl:start -->').length - 1, 1);
  assert.equal(html.split('<!-- meta:unfurl:end -->').length - 1, 1);
});

// A room is a PREFIX: /app/journal/2026-07-20 is a day in the canvas and /app/gym/shared/<token> is
// somebody's coach link, and both are still that room. The bare /app and the account surfaces are
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
test('every app room is flagged as booting', () => {
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
  assert.equal(ground, '#040D19');
  assert.equal(meta['theme-color'].content, '#040D19');
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
  assert.ok(BOOT_STYLE.includes('background:var(--surface-canvas,var(--wm-boot-ground))'));
  assert.ok(BOOT_STYLE.includes('html[data-wm-boot="app"] #root>main{display:none}'),
    'the marketing hero is no longer hidden on app rooms, or is being hidden everywhere');
  assert.ok(!/documentElement\.style\.background\s*=/.test(SCRIPT),
    'the boot sets an inline background again, which no stylesheet can take back');
});
