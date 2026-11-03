import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from '../browserFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import { TreeSwitcher } from '/src/products/roadmap/ui/TreeSwitcher.jsx';
createRoot(document.getElementById('fixture')).render(React.createElement(TreeSwitcher, {
  current: { id: 'sail', title: 'Learn to sail', done: 3, total: 8, dominantKind: 'sky' },
  listTrees: async () => [], onNew() {},
}));
window.entryReady = true;
`;
let server, browser, origin, ready;
function start() {
  ready ??= (async () => {
    server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-tree-switcher-test`,
      plugins: [{ name: 'tree-switcher-test', enforce: 'pre',
        resolveId(id) {
          if (id === '/tree-switcher-entry.js') return '\0tree-switcher-entry';
          if (id.endsWith('/telemetry/beacon.js')) return '\0tree-switcher-beacon';
        },
        load(id) {
          if (id === '\0tree-switcher-entry') return entry;
          if (id === '\0tree-switcher-beacon') return beacon;
        },
        configureServer(vite) {
          vite.middlewares.use('/tree-switcher-test', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="fixture" style="width:200px"></div><div id="blank" style="margin-top:300px;height:100px">Outside</div><script type="module" src="/tree-switcher-entry.js"></script>');
          });
        },
      }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
      server: { host: '127.0.0.1', port: 0 } });
    await server.listen(0);
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
  })();
  return ready;
}
after(async () => { await browser?.close(); await server?.close(); });

for (const via of ['blank', 'escape']) {
  test(`Chromium: the identity TreeSwitcher returns focus on ${via} dismissal`, async () => {
    await start();
    const page = await browser.newPage();
    try {
      await withBrowserErrors(page, async () => {
        await page.goto(`${origin}/tree-switcher-test`);
        await page.waitForFunction(() => window.entryReady);
        const trigger = page.locator('#fixture [aria-haspopup="menu"]');
        await trigger.click();
        await page.getByRole('menu').waitFor();
        await page.getByRole('menuitem').first().focus();
        if (via === 'blank') await page.locator('#blank').click();
        if (via === 'escape') await page.keyboard.press('Escape');
        await page.getByRole('menu').waitFor({ state: 'detached' });
        assert.deepEqual(await trigger.evaluate((button) => ({
          focused: document.activeElement === button,
          expanded: button.getAttribute('aria-expanded'),
          height: button.getBoundingClientRect().height,
          fontSize: getComputedStyle(button).fontSize,
          caret: { width: button.querySelector('svg').getBoundingClientRect().width, opacity: getComputedStyle(button.querySelector('svg')).opacity },
        })), { focused: true, expanded: 'false', height: 44, fontSize: '24px', caret: { width: 20, opacity: '1' } });
      });
    } finally { await page.close(); }
  });
}
