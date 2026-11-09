import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ShortcutsDialog } from '/src/products/roadmap/shortcuts/ShortcutsDialog.jsx';
const root = createRoot(document.getElementById('root'));
window.events = [];
function Fixture(props) {
  useEffect(() => { window.committed = props.revision; }, [props]);
  return React.createElement(ShortcutsDialog, { ...props, onClose() {} });
}
window.paint = (props) => flushSync(() => root.render(React.createElement(Fixture, props)));
`;
let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-shortcuts-test`,
    plugins: [{ name: 'shortcuts-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/shortcuts-entry.js') return '\0shortcuts-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0shortcut-events';
      },
      load(id) {
        if (id === '\0shortcuts-entry') return entry;
        if (id === '\0shortcut-events') return 'export function track(name, props) { window.events.push({ name, props }); } export function reportError(error) { throw error; } export function routeFamily(route) { return route; }';
      },
      configureServer(server) {
        server.middlewares.use('/shortcuts-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><div id="root"></div><script type="module" src="/shortcuts-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client'] }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => { try { await ready; } finally { await browser?.close(); await server?.close(); } });

for (const view of ['graph', 'board']) {
  test(`Chromium: shortcuts ${view} emits its opening event each time it opens`, async () => {
    await ready;
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/shortcuts-test`);
      await page.waitForFunction(() => typeof window.paint === 'function');
      const render = async (open, revision) => {
        await page.evaluate((props) => window.paint(props), { view, open, revision });
        await page.waitForFunction((revision) => window.committed === revision, revision);
      };
      await render(false, 1);
      assert.deepEqual(await page.evaluate(() => window.events), []);
      await render(true, 2);
      const opened = [{ name: 'roadmap_shortcuts_open', props: { view } }];
      assert.deepEqual(await page.evaluate(() => window.events), opened);
      await render(true, 3);
      await render(false, 4);
      assert.deepEqual(await page.evaluate(() => window.events), opened);
      await render(true, 5);
      assert.deepEqual(await page.evaluate(() => window.events), [...opened, ...opened]);
    } finally { await page.close(); }
  });
}
