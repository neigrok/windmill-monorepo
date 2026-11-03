import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import { TendBar } from '/src/products/roadmap/tending/TendBar.jsx';
window.submitted = [];
window.dismissed = 0;
createRoot(document.getElementById('root')).render(React.createElement(TendBar, {
  variant: 'desktop', examples: ['Is this realistic?', 'What am I missing?'],
  onSubmit(value) { window.submitted.push(value); },
  onDismiss() { window.dismissed += 1; },
}));
`;
let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-tend-band-test`,
    plugins: [{ name: 'tend-band-test',
      resolveId(id) { if (id === '/tend-band-entry.js') return '\0tend-band-entry'; },
      load(id) { if (id === '\0tend-band-entry') return entry; },
      configureServer(server) {
        server.middlewares.use('/tend-band-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/tend-band-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client'] }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => { try { await ready; } finally { await browser?.close(); await server?.close(); } });

for (const width of [320, 390, 744]) {
  test(`Chromium: the shipped Ask AI overlay fits and accepts input at ${width}px`, async () => {
    await ready;
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    try {
      await page.goto(`${origin}/tend-band-test`);
      const input = page.getByRole('textbox', { name: 'Tell the tree what to change' });
      await input.waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
      const geometry = await page.locator('form').evaluate((form) => {
        const box = form.getBoundingClientRect();
        return {
          fits: box.left >= 0 && box.right <= innerWidth,
          controlsFit: [...form.querySelectorAll('button,input')].every((element) => {
            const control = element.getBoundingClientRect();
            return control.left >= box.left && control.right <= box.right && control.width > 0;
          }),
          width: box.width,
        };
      });
      assert.deepEqual(geometry, { fits: true, controlsFit: true, width: Math.min(560, width - 48) });
      await input.fill('Add a practice step');
      await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.submitted), ['Add a practice step']);
      await input.press('Escape');
      assert.equal(await page.evaluate(() => window.dismissed), 1);
    } finally {
      await page.close();
    }
  });
}
