import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from '../browserFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import { TreeSwitcher } from '/src/products/roadmap/identity/TreeSwitcher.jsx';
window.mount = (rows) => createRoot(document.getElementById('fixture')).render(React.createElement(TreeSwitcher, {
  current: { id: 'sail', title: 'Learn to sail', done: 3, total: 8, dominantKind: 'sky' },
  listTrees: async () => rows, onNew() {},
  onRename: async (...args) => {
    (window.renames ??= []).push(args);
    if (window.failRename) throw new Error('Private rename text');
  },
  onPreviewTitle: (...args) => { (window.previews ??= []).push(args); },
  onDelete: async (...args) => {
    (window.deletes ??= []).push(args);
    if (window.failDelete) throw new Error('Private delete text');
    if (window.deferDelete) await new Promise((resolve, reject) => {
      window.finishDelete = resolve;
      window.rejectDelete = reject;
      (window.finishDeletes ??= {})[args[0]] = resolve;
    });
  },
}));
window.entryReady = true;
`;

export function createTreeSwitcherHost(name) {
  let server, browser, webkitBrowser, origin, ready, cacheDir;

  async function withSwitcher(rows, run, { engine = 'Chromium', width = 1440, touch = false } = {}) {
    ready ??= (async () => {
      cacheDir = await mkdtemp(`${root}node_modules/.vite-tree-switcher-${name}-`);
      server = await createServer({ configFile: false, root, cacheDir,
        plugins: [{ name: 'tree-switcher-test', enforce: 'pre',
          resolveId(id) {
            if (id === '/tree-switcher-entry.js') return '\0tree-switcher-entry';
            if (id.endsWith('/telemetry/beacon.js')) return '\0tree-switcher-beacon';
            if (id.endsWith('/telemetry/sentry.js')) return '\0tree-switcher-sentry';
          },
          load(id) {
            if (id === '\0tree-switcher-entry') return entry;
            if (id === '\0tree-switcher-beacon') return beacon;
            if (id === '\0tree-switcher-sentry') return 'export function captureError(...args) { (window.failures ??= []).push(args); }';
          },
          configureServer(vite) {
            vite.middlewares.use('/tree-switcher-test', (_request, response) => {
              response.setHeader('Content-Type', 'text/html');
              response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="fixture" style="width:200px"></div><div id="blank" style="margin-top:300px;height:100px">Outside</div><script type="module" src="/tree-switcher-entry.js"></script>');
            });
          },
        }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
        server: { host: '127.0.0.1', port: 0 } });
      await new Promise((resolve, reject) => {
        server.httpServer.once('error', reject);
        server.httpServer.listen(0, '127.0.0.1', resolve);
      });
      origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      browser = await chromium.launch({ headless: true });
    })();
    await ready;
    if (engine === 'WebKit') webkitBrowser ??= await webkit.launch({ headless: true });
    const page = await (engine === 'WebKit' ? webkitBrowser : browser).newPage({ viewport: { width, height: 900 }, hasTouch: touch, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(20000);
    try {
      await withBrowserErrors(page, async () => {
        await page.goto(`${origin}/tree-switcher-test`);
        await page.waitForFunction(() => window.entryReady);
        await page.evaluate((list) => window.mount(list), rows);
        await run(page);
      });
    } finally { await page.close(); }
  }

  async function close() {
    try { await ready; } finally {
      try { await Promise.all([browser?.close(), webkitBrowser?.close()]); } finally {
        try { await server?.close(); } finally {
          if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
        }
      }
    }
  }

  return { withSwitcher, close };
}

export async function openMenu(page) {
  await page.locator('#fixture [aria-haspopup="menu"]').click();
  await page.getByRole('menu').waitFor();
}
