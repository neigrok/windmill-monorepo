import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

test('gallery explains publication in its app and linked page', async (t) => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import '/src/products/roadmap/skilltree.css';
import { BrowsePage } from '/src/products/roadmap/browse/BrowsePage.jsx';
createRoot(document.getElementById('fixture')).render(React.createElement(BrowsePage));
`;
  const html = await readFile(new URL('../../../../public/gallery.html', import.meta.url), 'utf8');
  const server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-gallery-disclosure`,
    plugins: [{ name: 'gallery-disclosure', enforce: 'pre',
      resolveId(id) {
        if (id === '/gallery-disclosure-entry.js') return '\0gallery-disclosure-entry';
        if (id.endsWith('/auth/AuthProvider.jsx')) return '\0gallery-disclosure-auth';
      },
      load(id) {
        if (id === '\0gallery-disclosure-entry') return entry;
        if (id === '\0gallery-disclosure-auth') return "export const useAuth = () => ({ status: 'signed-out', user: null });";
      },
      configureServer(vite) {
        vite.middlewares.use('/gallery-disclosure', (request, response) => {
          response.setHeader('Content-Type', 'text/html');
          if (request.url === '/app') {
            response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="fixture"></div><script type="module" src="/gallery-disclosure-entry.js"></script>');
            return;
          }
          const body = request.url === '/populated'
            ? html.replace(/(<!-- wall:cards:start -->)[\s\S]*?(<!-- wall:cards:end -->)/, '$1<article>Published roadmap</article>$2')
            : html;
          response.end(body);
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0 } });
  await server.listen(0);
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const [width, theme] of [[390, 'light'], [1440, 'dark']]) {
      await t.test(`gallery disclosure stays truthful at ${width}px in ${theme} mode`, async () => {
        const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme });
        const page = await context.newPage();
        const errors = [];
        let entries = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route(/\/v1\//, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: entries.length, entries, nextCursor: '' }) }));
        try {
          await page.goto(`${origin}/gallery-disclosure/app`);
          await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
          await page.locator('.wm-br-bare').waitFor();
          assert.equal(await page.locator('.wm-br-sub').innerText(), 'Public roadmaps, ranked by the forks they have inspired. Open one to see its progress — or sign in to fork it.');
          assert.equal(await page.locator('.wm-br-bare p').innerText(), 'Publishing makes your roadmap public. Anyone can view it or sign in to fork it, and it can appear in the public gallery.');
          assert.equal(await page.getByRole('link', { name: 'How a tree gets here' }).getAttribute('href'), '/gallery');
          assert.equal(await page.getByRole('link', { name: 'Plant a tree' }).getAttribute('href'), '#/app/new');
          entries = [{ id: 't_gallery', title: 'Example roadmap', done: 1, total: 3, dominantKind: 'sky', forks: 1, updatedAt: 1700000000000 }];
          await page.reload();
          await page.getByText('Example roadmap').waitFor();
          assert.equal(await page.locator('.wm-br-sub').innerText(), 'Public roadmaps, ranked by the forks they have inspired. Open one to see its progress — or sign in to fork it.');
          assert.equal(await page.locator('.wm-br-bare').count(), 0);
          for (const state of ['empty', 'populated']) {
            await page.goto(`${origin}/gallery-disclosure/${state}`);
            await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
            assert.deepEqual(await page.locator('.how p').allInnerTexts(), [
              'Publishing a roadmap makes it public. Anyone can view it or sign in to fork it, and it can appear in the public gallery.',
              'You can make your roadmap private again. Privacy · Start your own',
            ]);
            assert.equal(await page.locator('.how a').first().getAttribute('href'), '/privacy.html');
            assert.equal(await page.locator('.how a').last().getAttribute('href'), '/#/app');
            if (state === 'empty') {
              assert.equal(await page.locator('.empty p').innerText(), 'Publishing makes your roadmap public. Anyone can view it or sign in to fork it, and it can appear in the public gallery.');
              assert.equal(await page.locator('.empty a').getAttribute('href'), '/#/app');
            } else {
              assert.equal(await page.locator('.empty').count(), 0);
              assert.equal(await page.locator('article').innerText(), 'Published roadmap');
            }
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          }
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    }
  } finally {
    await browser?.close();
    await server.close();
  }
});
