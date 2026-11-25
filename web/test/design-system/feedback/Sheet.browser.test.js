import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { withBrowserErrors } from '../../products/roadmap/browserFixture.js';

// The bottom sheet in Chromium under React's StrictMode, as `npm run dev` renders it: StrictMode runs each layout effect,
// its cleanup and the effect again, so the dialog is shown, closed and shown again as it mounts.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Sheet } from '/src/design-system/feedback/Sheet.jsx';
import '/src/styles/global.css';
const e = React.createElement;
window.closes = 0;
function Fixture() {
  const [open, setOpen] = useState(false);
  return e(React.Fragment, null, e('button', { id: 'opener', onClick: () => setOpen(true) }, 'Open'),
    open && e(Sheet, { label: 'A sheet', onClose: () => { window.closes += 1; setOpen(false); } }, e('button', { id: 'inside' }, 'Inside')));
}
createRoot(document.getElementById('root')).render(e(React.StrictMode, null, e(Fixture)));
window.entryReady = true;
`;
let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-sheet-test`,
    plugins: [{ name: 'sheet-test', enforce: 'pre',
      resolveId(id) { if (id === '/sheet-entry.js') return '\0sheet-entry'; },
      load(id) { if (id === '\0sheet-entry') return entry; },
      configureServer(vite) {
        vite.middlewares.use('/sheet-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><div id="root"></div><script type="module" src="/sheet-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client'] }, server: { host: '127.0.0.1', port: 0 } });
  const listening = once(server.httpServer, 'listening');
  server.httpServer.listen(0, '127.0.0.1');
  await listening;
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
ready.catch(() => {});
after(async () => { await browser?.close(); await server?.close(); });

test('Chromium: under StrictMode a Sheet stays open as it opens, and Escape still closes it once', async (t) => {
  await ready;
  const page = await browser.newPage();
  t.after(() => page.close());
  await withBrowserErrors(page, async () => {
    await page.goto(`${origin}/sheet-test`);
    await page.waitForFunction(() => window.entryReady);
    await page.locator('#opener').click();
    await page.getByRole('dialog', { name: 'A sheet' }).waitFor();
    await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(() => ({ open: document.querySelector('dialog.wm-sheet')?.open ?? null, closes: window.closes })),
      { open: true, closes: 0 }, 'the close the second effect run queued closes nothing');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'A sheet' }).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.closes), 1);
  });
});
