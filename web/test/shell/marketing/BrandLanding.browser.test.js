import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'vite';
import { chromium } from 'playwright';
import { beacon } from '../../products/roadmap/browserFixture.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrandLanding } from '/src/shell/marketing/BrandLanding.jsx';
import { ProductSessions } from '/src/shell/ProductSessions.jsx';
import { DocumentDataScope } from '/src/shell/auth/accountChange.js';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
const scope = new DocumentDataScope();
scope.reconcile({ device: { meta: {}, activeReplica: { meta: { state: 'anon' } } } });
createRoot(document.getElementById('root')).render(React.createElement(ProductSessions, { dataScope: scope.read, products: [] }, React.createElement(BrandLanding)));
`;
const PICTURES = { roadmap: 'rmPicture', journal: 'jnPicture', gym: 'gyPicture' };

let server, browser, origin;
let mode = 'open';
const ready = (async () => {
  const { output } = await build({ configFile: false, root, logLevel: 'silent', mode: 'development',
    plugins: [{ name: 'front-page-fixture', enforce: 'pre', resolveId(id) {
      if (id === '/front-page.js') return '\0entry';
      if (id.endsWith('/auth/AuthProvider.jsx')) return '\0auth';
      if (id.endsWith('/auth/SignInDoor.jsx')) return '\0door';
      if (id.endsWith('/telemetry/beacon.js')) return '\0events';
      if (id.endsWith('/telemetry/sentry.js')) return '\0sentry';
    }, load(id) {
      if (id === '\0entry') return entry;
      if (id === '\0auth') return 'export const useAuth = () => ({ status: "ghost", user: null, signOut() {} });';
      if (id === '\0door') return 'export const useSignInDoor = () => () => {}; export const useSignInDoorHost = () => () => {};';
      if (id === '\0events') return beacon;
      if (id === '\0sentry') return 'export function captureError(kind, operation) { (window.captured ??= []).push([kind, operation]); }';
    } }], build: { write: false, minify: false, cssCodeSplit: false, modulePreload: false,
      rollupOptions: { input: '/front-page.js', output: { entryFileNames: 'entry.js' } } } });
  const files = new Map(output.map((file) => ['/' + file.fileName, file.type === 'chunk' ? file.code : file.source]));
  const pictureOf = (path) => Object.entries(PICTURES).find(([, name]) => path !== '/entry.js' && path.endsWith('.js') && files.get(path).includes(`"${name}`))?.[0];
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

async function frames(width, { waitFor }) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.locator('h1').waitFor({ timeout: 30000 });
  if (waitFor) await page.locator(waitFor).first().waitFor({ timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  const seen = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    frames: [...document.querySelectorAll('.front-picture-body')].map((body) => {
      const stage = body.querySelector('.front-picture-stage');
      const picture = stage?.firstElementChild ?? null;
      return { brand: body.dataset.brand, body: body.getBoundingClientRect().height, bodyWidth: body.clientWidth,
        stage: stage && [stage.offsetWidth, stage.offsetHeight], drawn: picture && [picture.dataset.stage, picture.offsetHeight, picture.scrollWidth, picture.getBoundingClientRect().width] };
    }),
    captured: window.captured ?? [],
    alert: document.querySelector('[role="alert"]')?.textContent ?? null,
    plaqueCovers: [...document.querySelectorAll('.rmPicture .plq')].flatMap((plaque) => {
      const p = plaque.getBoundingClientRect();
      return [...plaque.parentElement.querySelectorAll('.nd, .ndlabel, .rmTree-crown')].filter((node) => {
        const b = node.getBoundingClientRect();
        return b.left < p.right && b.right > p.left && b.top < p.bottom && b.bottom > p.top;
      }).map((node) => node.textContent || node.className);
    }),
  }));
  await page.close();
  return { ...seen, errors };
}

for (const width of [320, 390, 744, 1024, 1152, 1440]) {
  test(`${width}px: each frame holds its picture's real height from the first paint, before the picture's chunk arrives`, { timeout: 90000 }, async () => {
    await ready;
    mode = 'hold';
    const held = await frames(width, { waitFor: '.front-picture-stage' });
    mode = 'open';
    const drawn = await frames(width, { waitFor: '.gyPicture' });
    assert.deepEqual([held.errors, drawn.errors], [[], []]);
    assert.deepEqual(held.frames.map((frame) => frame.drawn), [null, null, null], 'a picture was drawn while its chunk was held');
    assert.deepEqual(held.frames.map((frame) => frame.body), drawn.frames.map((frame) => frame.body));
    assert.equal(held.height, drawn.height);
    assert.deepEqual(drawn.plaqueCovers, [], 'the sail tree\'s plaque covers a step or a label');
    for (const frame of drawn.frames) {
      const [, stageHeight] = frame.stage;
      const [, pictureHeight, pictureWidth, shownWidth] = frame.drawn;
      assert.ok(Math.abs(pictureHeight - stageHeight) <= 1, `${frame.brand}: drawn ${pictureHeight}px on a ${stageHeight}px stage`);
      assert.ok(pictureWidth <= frame.stage[0], `${frame.brand}: drawn ${pictureWidth}px wide on a ${frame.stage[0]}px stage`);
      assert.ok(shownWidth <= frame.bodyWidth + 0.5, `${frame.brand}: shown ${shownWidth}px wide in a ${frame.bodyWidth}px frame`);
    }
  });
}

test('a picture whose chunk fails leaves the page whole, its frame at its height, and reports once which room it was', { timeout: 90000 }, async () => {
  await ready;
  mode = 'open';
  const drawn = await frames(390, { waitFor: '.gyPicture' });
  mode = 'fail-gym';
  const failed = await frames(390, { waitFor: '.rmPicture' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  mode = 'open';
  assert.equal(failed.alert, null);
  assert.deepEqual(failed.frames.map((frame) => [frame.brand, frame.body, frame.drawn?.[0] ?? null]),
    drawn.frames.map((frame) => [frame.brand, frame.body, frame.brand === 'gym' ? null : frame.drawn[0]]));
  assert.equal(failed.height, drawn.height);
  assert.deepEqual(failed.captured, [['render', 'front-picture-gym']]);
});
