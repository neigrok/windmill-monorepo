import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'vite';
import { chromium } from 'playwright';
import { beacon } from '../../products/roadmap/browserFixture.js';
import { PRODUCTS } from '../../../src/shell/products.js';
import { productLandingMain } from '../../../scripts/productLandingBody.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProductLanding } from '/src/shell/marketing/ProductLanding.jsx';
import { ProductSessions } from '/src/shell/ProductSessions.jsx';
import { DocumentDataScope } from '/src/shell/auth/accountChange.js';
import { PRODUCTS } from '/src/shell/products.js';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
const scope = new DocumentDataScope();
scope.reconcile({ device: { meta: {}, activeReplica: { meta: { state: 'anon' } } } });
const product = PRODUCTS.find((each) => each.id === new URLSearchParams(location.search).get('product'));
product.landing.page().then((page) => createRoot(document.getElementById('root'))
  .render(React.createElement(ProductSessions, { dataScope: scope.read, products: [] }, React.createElement(ProductLanding, { product, page }))));
`;
// What a chunk holds that makes it a product's picture, the brand root's or the landing's own.
const PICTURES = { roadmap: ['rmPicture', 'rmHero'], journal: ['jnPicture', 'jnNight'], gym: ['gyPicture', 'gyScene'] };

let server, browser, origin;
let mode = 'open';
const ready = (async () => {
  const { output } = await build({ configFile: false, root, logLevel: 'silent', mode: 'development',
    plugins: [{ name: 'product-landing-fixture', enforce: 'pre', resolveId(id) {
      if (id === '/product-landing.js') return '\0entry';
      if (id.endsWith('/auth/AuthProvider.jsx')) return '\0auth';
      if (id.endsWith('/auth/SignInDoor.jsx')) return '\0door';
      if (id.endsWith('/telemetry/beacon.js')) return '\0events';
      if (id.endsWith('/telemetry/sentry.js')) return '\0sentry';
    }, load(id) {
      if (id === '\0entry') return entry;
      if (id === '\0auth') return 'export const useAuth = () => ({ status: "ghost", user: null, signOut() {} }); export default function AuthProvider({ children }) { return children; }';
      if (id === '\0door') return 'export const useSignInDoor = () => () => {}; export const useSignInDoorHost = () => () => {};';
      if (id === '\0events') return beacon;
      if (id === '\0sentry') return 'export function captureError(kind, operation, stack, route) { (window.captured ??= []).push([kind, operation, route]); }';
    } }], build: { write: false, minify: false, cssCodeSplit: false, modulePreload: false,
      rollupOptions: { input: '/product-landing.js', output: { entryFileNames: 'entry.js' } } } });
  const files = new Map(output.map((file) => ['/' + file.fileName, file.type === 'chunk' ? file.code : file.source]));
  const pictureOf = (path) => Object.entries(PICTURES).find(([, names]) => path !== '/entry.js' && path.endsWith('.js')
    && names.some((name) => files.get(path).includes(name)))?.[0];
  const css = [...files.keys()].find((name) => name.endsWith('.css'));
  server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const product = pictureOf(path);
    if (product && mode === 'hold') return;
    if (product && mode === `fail-${product}`) { response.statusCode = 404; response.end(); return; }
    if (path.startsWith('/v1/') || path.endsWith('.svg')) { response.statusCode = 404; response.end(); return; }
    response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.woff2') ? 'font/woff2' : 'text/html');
    response.end(files.get(path) ?? `<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${css}"><div id="root"></div><script type="module" src="/entry.js"></script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
ready.catch(() => {});
after(async () => { try { await ready; } finally { await browser?.close(); server?.close(); } });

const PICTURE_SELECTOR = '.front-picture-stage > :first-child';

async function visit(product, width, { waitFor, noJs = null }) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/?product=${product}`);
  await page.locator('h1').waitFor({ timeout: 30000 });
  if (waitFor) await page.locator(waitFor).first().waitFor({ timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  const seen = await page.evaluate((html) => {
    const outline = (rootElement) => [...rootElement.querySelectorAll('h1, h2, h3, p, a, dt, dd')].filter((element) => !element.closest('figure'))
      .map((element) => [element.tagName, element.textContent.replace(/\s+/g, ' ').trim(), element.getAttribute('href')]);
    const first = html ? Object.assign(document.createElement('div'), { innerHTML: html }) : null;
    return {
      height: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      frames: [...document.querySelectorAll('.front-picture-body')].map((body) => {
        const stage = body.querySelector('.front-picture-stage');
        const picture = stage?.firstElementChild ?? null;
        return { body: body.getBoundingClientRect().height, bodyWidth: body.clientWidth, stage: stage && [stage.offsetWidth, stage.offsetHeight],
          drawn: picture && [picture.dataset.stage, picture.offsetHeight, picture.scrollHeight, picture.scrollWidth] };
      }),
      targets: [...document.querySelectorAll('main a')].map((element) => [element.textContent.trim(), Math.round(element.getBoundingClientRect().height)]),
      outline: outline(document.querySelector('main')),
      firstHtml: first && outline(first),
      captured: window.captured ?? [],
      alert: document.querySelector('[role="alert"]')?.textContent ?? null,
    };
  }, noJs);
  await page.close();
  return { ...seen, errors };
}

for (const product of PRODUCTS.map((each) => each.id)) {
  for (const width of [320, 390, 744, 1024, 1440]) {
    test(`${product} at ${width}px: each frame holds its picture's real height from the first paint, and the picture fits its stage`, { timeout: 120000 }, async () => {
      await ready;
      mode = 'hold';
      const held = await visit(product, width, { waitFor: '.front-picture-stage' });
      mode = 'open';
      const drawn = await visit(product, width, { waitFor: PICTURE_SELECTOR });
      assert.deepEqual([held.errors, drawn.errors], [[], []]);
      assert.equal(held.frames.every((frame) => frame.drawn === null), true, 'a picture was drawn while its chunk was held');
      assert.deepEqual(held.frames.map((frame) => frame.body), drawn.frames.map((frame) => frame.body));
      assert.equal(held.height, drawn.height);
      assert.ok(drawn.scrollWidth <= width, `the page scrolls sideways: ${drawn.scrollWidth}px at ${width}px`);
      for (const [index, frame] of drawn.frames.entries()) {
        const [stageWidth, stageHeight] = frame.stage;
        const [, pictureHeight, contentHeight, contentWidth] = frame.drawn;
        assert.ok(Math.abs(pictureHeight - stageHeight) <= 1, `picture ${index}: drawn ${pictureHeight}px on a ${stageHeight}px stage`);
        assert.ok(contentHeight <= stageHeight + 1, `picture ${index}: its content runs ${contentHeight}px on a ${stageHeight}px stage`);
        assert.ok(contentWidth <= stageWidth + 1, `picture ${index}: its content runs ${contentWidth}px wide on a ${stageWidth}px stage`);
      }
      if (width <= 390) {
        assert.deepEqual(drawn.targets.filter(([, height]) => height < 44), [], 'a link of the page is under 44px tall on a phone');
      }
    });
  }

  test(`${product}: the first HTML says what the running page says, in the same order and elements`, { timeout: 120000 }, async () => {
    await ready;
    mode = 'open';
    const page = await PRODUCTS.find((each) => each.id === product).landing.page();
    const seen = await visit(product, 1440, { waitFor: PICTURE_SELECTOR, noJs: productLandingMain(page) });
    assert.deepEqual(seen.firstHtml, seen.outline);
  });
}

test('a picture whose chunk fails leaves the landing whole, its frames at their height, and reports which product it was', { timeout: 120000 }, async () => {
  await ready;
  mode = 'open';
  const drawn = await visit('gym', 390, { waitFor: '.gyScene' });
  mode = 'fail-gym';
  const failed = await visit('gym', 390, { waitFor: '.front-picture-stage' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  mode = 'open';
  assert.equal(failed.alert, null);
  assert.deepEqual(failed.frames.map((frame) => frame.body), drawn.frames.map((frame) => frame.body));
  assert.equal(failed.height, drawn.height);
  assert.ok(failed.captured.length > 0);
  assert.deepEqual([...new Set(failed.captured.map((report) => report.join(' ')))], ['render front-picture-gym /gym']);
});
