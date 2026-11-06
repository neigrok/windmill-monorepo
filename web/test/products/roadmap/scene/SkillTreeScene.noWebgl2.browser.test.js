import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from '../browserFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import { GraphUnavailable, SkillTreeScene } from '/src/products/roadmap/scene/SkillTreeScene.js';
window.events = [];
try {
  new SkillTreeScene(document.querySelector('canvas'));
  window.result = { threw: false };
} catch (error) {
  window.result = { threw: true, typed: error instanceof GraphUnavailable, message: error.message };
}
`;
let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-scene-unavailable-test`,
    plugins: [{ name: 'scene-unavailable-test', enforce: 'pre',
      resolveId(id, importer) {
        if (id === '/scene-unavailable-entry.js') return '\0scene-unavailable-entry';
        const file = id.startsWith('.') && importer ? resolve(dirname(importer), id) : id;
        if (file.endsWith('/telemetry/beacon.js')) return '\0scene-unavailable-events';
      },
      load(id) {
        if (id === '\0scene-unavailable-entry') return entry;
        if (id === '\0scene-unavailable-events') return beacon;
      },
      configureServer(server) {
        server.middlewares.use('/scene-unavailable-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><canvas></canvas><script type="module" src="/scene-unavailable-entry.js"></script>');
        });
      },
    }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => { try { await ready; } finally { await browser?.close(); await server?.close(); } });

test('Chromium: real renderer throws exported GraphUnavailable before any frame and emits no telemetry', async () => {
  await ready;
  const page = await browser.newPage();
  try {
    await withBrowserErrors(page, async () => {
      await page.addInitScript(() => {
        window.glRequests = 0;
        window.frames = 0;
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
          if (kind !== 'webgl2') return getContext.call(this, kind, ...args);
          window.glRequests += 1;
          return null;
        };
        window.requestAnimationFrame = () => { window.frames += 1; return 1; };
      });
      await page.goto(`${origin}/scene-unavailable-test`);
      await page.waitForFunction(() => !!window.result, null, { polling: 20 });
      assert.deepEqual(await page.evaluate(() => ({ result: window.result, events: window.events, requests: window.glRequests, frames: window.frames })), {
        result: { threw: true, typed: true, message: 'WebGL2 is not available' }, events: [], requests: 1, frames: 0,
      });
    });
  } finally { await page.close(); }
});
