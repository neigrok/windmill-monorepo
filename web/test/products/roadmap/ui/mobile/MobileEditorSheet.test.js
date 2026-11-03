import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from '../../board/composerFixture.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MobileEditorSheet } from '/src/products/roadmap/ui/mobile/MobileEditorSheet.jsx';
const noop = () => {};
function Room({ panel }) {
  const [state, setState] = useState('available');
  return React.createElement(MobileEditorSheet, {
    node: { id: 'wind', label: 'Read the wind', color: 'sky' }, state, panel,
    onMarkDone: (id) => { window.calls.push(['complete', id]); setState('complete'); },
    onUnmarkDone: (id) => { window.calls.push(['reset', id]); setState('available'); },
    onRename: noop, onAddStep: noop, onConnect: noop, onSetKind: noop, onDelete: noop,
  });
}
window.openSheet = (panel) => {
  window.calls = [];
  createRoot(document.getElementById('root')).render(React.createElement(Room, { panel }));
};
window.entryReady = true;
`;
let server, browser, origin, ready;
function start() {
  ready ??= (async () => {
    server = await createServer({
      configFile: false, root, cacheDir: `${root}/node_modules/.vite-mobile-editor-focus-test`,
      plugins: [{ name: 'mobile-editor-focus-test', enforce: 'pre',
        resolveId(id) {
          if (id === '/mobile-editor-entry.js') return '\0mobile-editor-entry';
          if (id.endsWith('/telemetry/beacon.js')) return '\0mobile-editor-beacon';
        },
        load(id) {
          if (id === '\0mobile-editor-entry') return entry;
          if (id === '\0mobile-editor-beacon') return beacon;
        },
        configureServer(server) {
          server.middlewares.use('/mobile-editor-test', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Editor focus test</title><div id="root"></div><script type="module" src="/mobile-editor-entry.js"></script>');
          });
        },
      }],
      optimizeDeps: { include: ['react', 'react-dom/client'] },
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen(0);
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
  })();
  return ready;
}
after(async () => {
  await ready?.catch(() => {});
  await browser?.close();
  await server?.close();
});

for (const width of [390, 744]) {
  test(`Chromium ${width}: completion and reset preserve the focused editor action node`, async () => {
    await start();
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await withBrowserErrors(page, async () => {
        await page.goto(`${origin}/mobile-editor-test`);
        await page.waitForFunction(() => window.entryReady);
        await page.evaluate((panel) => window.openSheet(panel), width >= 744);
        const complete = page.getByRole('button', { name: 'Mark done', exact: true });
        await complete.waitFor();
        await complete.focus();
        await page.evaluate(() => { window.originalAction = document.activeElement; });
        await page.keyboard.press('Enter');
        await page.getByRole('button', { name: 'Mark not done', exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(() => ({
          same: document.activeElement === window.originalAction,
          text: document.activeElement.textContent,
          calls: window.calls,
        })), { same: true, text: 'Mark not done', calls: [['complete', 'wind']] });
        await page.keyboard.press('Enter');
        await complete.waitFor();
        assert.deepEqual(await page.evaluate(() => ({
          same: document.activeElement === window.originalAction,
          text: document.activeElement.textContent,
          calls: window.calls,
        })), { same: true, text: 'Mark done', calls: [['complete', 'wind'], ['reset', 'wind']] });
      });
    } finally {
      await page.close();
    }
  });
}
