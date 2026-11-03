import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { withBrowserErrors } from '../board/composerFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Minimap } from '/src/products/roadmap/ui/Minimap.jsx';
const observer = { disconnected: false, callback: null };
window.MutationObserver = class {
  constructor(callback) { observer.callback = callback; }
  observe() {}
  disconnect() { observer.disconnected = true; }
};
const room = createRoot(document.getElementById('root'));
room.render(React.createElement(Minimap, {
  nodes: [{ id: 'wind', x: 5, y: 5, color: 'sky' }],
  states: new Map([['wind', 'available']]),
  bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
}));
window.observer = observer;
window.leaveGraph = () => {
  room.unmount();
  observer.callback();
};
window.entryReady = true;
`;
let server, browser;
after(async () => {
  await browser?.close();
  await server?.close();
});

test('Chromium: leaving Graph disconnects the minimap theme observer and tolerates a queued callback', async () => {
  server = await createServer({
    configFile: false, root, cacheDir: `${root}/node_modules/.vite-minimap-unmount-test`,
    plugins: [{ name: 'minimap-unmount-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/minimap-entry.js') return '\0minimap-entry';
      },
      load(id) {
        if (id === '\0minimap-entry') return entry;
      },
      configureServer(server) {
        server.middlewares.use('/minimap-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Minimap unmount test</title><div id="root"></div><script type="module" src="/minimap-entry.js"></script>');
        });
      },
    }],
    optimizeDeps: { include: ['react', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen(0);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await withBrowserErrors(page, async () => {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/minimap-test`);
      await page.waitForFunction(() => window.entryReady && window.observer.callback !== null);
      assert.equal(await page.locator('.st-minimap').count(), 1);
      assert.equal(await page.evaluate(() => window.observer.disconnected), false);
      await page.evaluate(() => window.leaveGraph());
      assert.equal(await page.locator('.st-minimap').count(), 0);
      assert.equal(await page.evaluate(() => window.observer.disconnected), true);
    });
  } finally {
    await page.close();
  }
});
