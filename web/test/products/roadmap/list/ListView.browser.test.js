import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from '../board/composerFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ListView } from '/src/products/roadmap/list/ListView.jsx';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import '/src/styles/global.css';
const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
  { id: 'course', label: 'Choose a course', color: 'olive', prerequisites: [] },
  { id: 'wind', label: 'Read the wind', color: 'sky', prerequisites: ['course'] },
  { id: 'dock', label: 'Leave the dock', color: 'sky', prerequisites: ['wind'] },
] });
const states = new Map([['course', 'complete'], ['wind', 'available'], ['dock', 'locked']]);
const prefs = { foldedSections: () => [], setFoldedSections: () => {} };
function Room() {
  const [selectedId, onSelect] = useState(null);
  return React.createElement(ListView, { tree, nodesById: tree.nodesById, states, prefs,
    header: { name: tree.title }, treeId: tree.id, active: true, selectedId, onSelect });
}
createRoot(document.getElementById('root')).render(React.createElement(Room));
`;
let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-list-copy-test`,
    plugins: [{ name: 'list-copy-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/list-copy-entry.js') return '\0list-copy-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0list-copy-beacon';
      },
      load(id) {
        if (id === '\0list-copy-entry') return entry;
        if (id === '\0list-copy-beacon') return beacon;
      },
      configureServer(server) {
        server.middlewares.use('/list-copy-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="root" style="height:100vh"></div><script type="module" src="/list-copy-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => { try { await ready; } finally { await browser?.close(); await server?.close(); } });

test('Chromium: the List shelf names its kind and a shelf jump returns to Up next', async () => {
  await ready;
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  try {
    await withBrowserErrors(page, async () => {
      await page.goto(`${origin}/list-copy-test`);
      const shelf = page.locator('.st-list-nextup-label');
      await shelf.waitFor();
      assert.equal(await shelf.evaluate((element) => element.outerHTML),
        '<div class="st-list-nextup-label"><span>Up next</span><span class="st-list-nextup-ready">1 up next</span></div>');
      await page.getByRole('group', { name: 'Filter by kind' }).getByRole('button', { name: 'Sky', exact: true }).click();
      await shelf.getByText('Up next in Sky', { exact: true }).waitFor();
      assert.equal(await shelf.evaluate((element) => element.outerHTML),
        '<div class="st-list-nextup-label"><span>Up next in Sky</span><span class="st-list-nextup-ready">1 up next</span></div>');
      await page.locator('.st-list-nextup-row').click();
      const back = page.locator('.st-list-backlane');
      await back.waitFor();
      assert.equal(await back.evaluate((element) => element.outerHTML),
        '<div class="st-list-backlane" role="status"><button type="button" class="st-list-back"><span class="st-list-back-arrow" aria-hidden="true">←</span><span class="st-list-back-label">Back to Up next</span></button></div>');
      await page.getByRole('button', { name: 'Back to Up next', exact: true }).click();
      await back.waitFor({ state: 'detached' });
    });
  } finally {
    await page.close();
  }
});
