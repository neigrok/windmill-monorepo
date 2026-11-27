// The site's events on the static pages in the instrument look (scripts/staticEvents.js, served as /events.js). Like
// staticAppearance.test.mjs, this drives the EMITTED ES5 against a document just real enough for it, and reads what
// leaves the page: every body the beacon or the keepalive request carries.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { LABELS, staticEventsScript } from '../../scripts/staticEvents.js';
import { staticPageAssets } from '../../scripts/staticPageAssets.js';

const SCRIPT = staticEventsScript();
const NOW = 1789550000000;

// An element is its attributes and its parent; `closest` walks up comparing what the script asks for.
function element(attributes = {}, parent = null) {
  return {
    attributes, parent,
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    closest(selector) {
      const [, tag, attribute] = /^(a)?\[([\w-]+)\]$/.exec(selector);
      for (let at = this; at; at = at.parent) {
        if ((!tag || at.tag === tag) && attribute in at.attributes) return at;
      }
      return null;
    },
  };
}
const link = (attributes, parent) => Object.assign(element(attributes, parent), { tag: 'a' });

function page({ pageLabel = 'pricing', hostname = 'windmill.works', stored = { 'windmill:beacon:key': 'stored-key' }, storageThrows = false, beacon = true, beaconAccepts = true, fetchRejects = false } = {}) {
  const storage = new Map(Object.entries(stored));
  const sent = [];
  const listeners = {};
  const context = {
    JSON, Blob, Date: { now: () => NOW }, Math,
    window: { location: { hostname }, crypto: { randomUUID: () => 'minted-key' } },
    document: {
      documentElement: element(pageLabel === null ? {} : { 'data-page': pageLabel }),
      addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    },
    localStorage: {
      getItem(key) { if (storageThrows) throw new Error('storage is disabled'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageThrows) throw new Error('storage is disabled'); storage.set(key, value); },
    },
    navigator: beacon ? {
      sendBeacon(url, blob) { sent.push({ via: 'beacon', url, blob }); return beaconAccepts; },
    } : {},
    fetch(url, request) {
      sent.push({ via: 'fetch', url, request });
      return fetchRejects ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve({ ok: true });
    },
  };
  context.window.localStorage = context.localStorage;
  vm.createContext(context);
  vm.runInContext(SCRIPT, context);
  const header = element({ 'data-area': 'header' });
  const sitemap = element({ 'data-area': 'sitemap' });
  return {
    storage, listeners, header, sitemap,
    click(target) { for (const fn of listeners.click ?? []) fn({ target }); },
    pick(detail) { for (const fn of listeners['wm-appearance'] ?? []) fn({ detail }); },
    async sent() {
      return Promise.all(sent.splice(0).map(async (send) => ({
        via: send.via,
        url: send.url,
        ...(send.via === 'beacon'
          ? { type: send.blob.type, body: JSON.parse(await send.blob.text()) }
          : { request: { ...JSON.parse(JSON.stringify(send.request)), body: JSON.parse(send.request.body) } }),
      })));
    },
  };
}

const beaconOf = (sessionKey, name, props) => ({
  via: 'beacon', url: '/v1/events', type: 'application/json',
  body: { sessionKey, events: [{ name, clientMs: NOW, props }] },
});

test('/events.js is emitted by the same asset map as /appearance.js, as plain ES5', () => {
  const emitted = [];
  staticPageAssets().generateBundle.call({ emitFile: (file) => emitted.push(file) });
  assert.equal(emitted.find((file) => file.fileName === 'events.js').source, SCRIPT);
  assert.equal(/\b(const|let|class)\s|=>|`/.test(SCRIPT), false, 'the script uses syntax /boot.js never does');
});

test('a page opens with one front_open beacon under the session key the app\'s beacon keeps', async () => {
  const p = page();
  assert.deepEqual(await p.sent(), [beaconOf('stored-key', 'front_open', { page: 'pricing' })]);
});

test('a labelled link tells front_link with its area, where it goes and its product, and nothing else', async () => {
  const p = page();
  await p.sent();
  const svg = element({}, link({ href: '/gym', 'data-to': 'landing', 'data-product': 'gym' }, p.header));
  p.click(svg);
  p.click(link({ href: '/support.html', 'data-to': 'support' }, p.sitemap));
  assert.deepEqual(await p.sent(), [
    beaconOf('stored-key', 'front_link', { page: 'pricing', area: 'header', to: 'landing', product: 'gym' }),
    beaconOf('stored-key', 'front_link', { page: 'pricing', area: 'sitemap', to: 'support' }),
  ]);
});

test('one use of a link tells one event: the second click of a double click tells nothing', async () => {
  const p = page();
  await p.sent();
  const target = link({ href: '/support.html', 'data-to': 'support' }, p.sitemap);
  for (const fn of p.listeners.click) fn({ target, detail: 1 });
  for (const fn of p.listeners.click) fn({ target, detail: 2 });
  assert.deepEqual(await p.sent(), [beaconOf('stored-key', 'front_link', { page: 'pricing', area: 'sitemap', to: 'support' })]);
});

test('a link without labels, with a label outside the lists or outside any area tells nothing', async () => {
  const p = page();
  await p.sent();
  p.click(link({ href: '#content' }, null));
  p.click(link({ href: '/x', 'data-to': 'somewhere' }, p.header));
  p.click(link({ href: '/x', 'data-to': 'landing', 'data-product': 'chess' }, p.header));
  p.click(link({ href: '/x', 'data-to': 'pricing' }, element({ 'data-area': 'basement' })));
  p.click(link({ href: '/x', 'data-to': 'pricing' }, null));
  p.click(element({}, element({ 'data-area': 'header' })));
  p.click(null);
  assert.deepEqual(await p.sent(), []);
});

test('a pick on the switch tells front_control in the shared footer\'s words; an unknown pick tells nothing', async () => {
  const p = page();
  await p.sent();
  for (const detail of ['system', 'light', 'dark', 'sepia', 'constructor', undefined]) p.pick(detail);
  assert.deepEqual(await p.sent(), ['auto', 'light', 'dark'].map((choice) => beaconOf('stored-key', 'front_control', { page: 'pricing', control: 'appearance', choice })));
});

test('every label the file can send is one web/OBSERVABILITY.md lists for its event', () => {
  const doc = fs.readFileSync(new URL('../../OBSERVABILITY.md', import.meta.url), 'utf8');
  const listed = (event, key) => new RegExp(`\`${key}\\??: ([\\w/]+)\``).exec(doc.split('\n').find((line) => line.includes(`| \`${event}\` |`)))[1].split('/');
  for (const key of ['page', 'area', 'to', 'product']) {
    assert.deepEqual(LABELS[key].filter((label) => !listed('front_link', key).includes(label)), [], key);
  }
  assert.ok(listed('front_open', 'page').includes('pricing') && listed('front_control', 'page').includes('pricing'));
  assert.deepEqual(['auto', 'light', 'dark'].filter((choice) => !listed('front_control', 'choice').includes(choice)), []);
  assert.deepEqual(LABELS, {
    page: ['pricing', 'support'],
    area: ['header', 'ways', 'content', 'sitemap', 'footer'],
    to: ['home', 'landing', 'app', 'sign_in', 'settings', 'pricing', 'connect', 'changelog', 'gallery', 'support', 'privacy', 'terms', 'refunds', 'feedback'],
    product: ['roadmap', 'journal', 'gym'],
  });
});

test('a page that names no page, or one outside the list, tells nothing and listens to nothing', async () => {
  for (const pageLabel of [null, 'front', '']) {
    const p = page({ pageLabel });
    assert.deepEqual(await p.sent(), []);
    assert.deepEqual(p.listeners, {});
  }
});

test('on localhost the page is muted as the app is, until a developer opts in', async () => {
  const muted = page({ hostname: 'localhost', stored: {} });
  muted.click(link({ href: '/gym', 'data-to': 'landing', 'data-product': 'gym' }, muted.header));
  muted.pick('dark');
  assert.deepEqual(await muted.sent(), []);
  assert.deepEqual([...muted.storage], [], 'a muted page mints no key, as the app\'s muted beacon does not');
  assert.deepEqual(await page({ hostname: 'localhost', storageThrows: true }).sent(), []);
  const opted = page({ hostname: 'localhost', stored: { 'windmill:beacon:dev': '1', 'windmill:beacon:key': 'stored-key' } });
  assert.deepEqual(await opted.sent(), [beaconOf('stored-key', 'front_open', { page: 'pricing' })]);
});

test('with no key stored the page mints one, keeps it where the app reads it, and reuses it', async () => {
  const p = page({ stored: {} });
  p.click(link({ href: '/', 'data-to': 'home' }, p.header));
  assert.deepEqual(await p.sent(), [
    beaconOf('minted-key', 'front_open', { page: 'pricing' }),
    beaconOf('minted-key', 'front_link', { page: 'pricing', area: 'header', to: 'home' }),
  ]);
  assert.deepEqual([...p.storage], [['windmill:beacon:key', 'minted-key']]);
  const locked = page({ storageThrows: true });
  locked.pick('light');
  assert.deepEqual(await locked.sent(), [
    beaconOf('minted-key', 'front_open', { page: 'pricing' }),
    beaconOf('minted-key', 'front_control', { page: 'pricing', control: 'appearance', choice: 'light' }),
  ]);
});

test('a refused or missing beacon is one keepalive request, and a failed one is dropped, never tried again', async () => {
  const keepalive = (props) => ({
    via: 'fetch', url: '/v1/events',
    request: { method: 'POST', credentials: 'include', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: { sessionKey: 'stored-key', events: [{ name: 'front_open', clientMs: NOW, props }] } },
  });
  const refused = page({ beaconAccepts: false });
  const tried = await refused.sent();
  assert.deepEqual(tried.map((send) => send.via), ['beacon', 'fetch']);
  assert.deepEqual(tried[1], keepalive({ page: 'pricing' }));
  assert.deepEqual(await page({ beacon: false }).sent(), [keepalive({ page: 'pricing' })]);
  const failing = page({ beacon: false, fetchRejects: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await failing.sent(), [keepalive({ page: 'pricing' })]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await failing.sent(), [], 'nothing is sent again after a failure');
});
