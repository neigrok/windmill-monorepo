import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

test('gallery reads report only wanted results and keep retries private', { timeout: 180000 }, async (t) => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const cacheDir = await mkdtemp(`${root}node_modules/.vite-gallery-reads-`);
  const server = await createServer({ configFile: false, root, cacheDir,
    define: { 'import.meta.env.VITE_SENTRY_DSN': JSON.stringify('https://abc@errors.example/42') },
    plugins: [{ name: 'gallery-reads', enforce: 'pre',
      resolveId(id) {
        if (id === '/gallery-reads-entry.js') return '\0gallery-reads-entry';
        if (id.endsWith('/auth/AuthProvider.jsx')) return '\0gallery-reads-auth';
      },
      load(id) {
        if (id === '\0gallery-reads-auth') return "export const useAuth = () => ({ status: 'signed-out', user: null });";
        if (id === '\0gallery-reads-entry') return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import { BrowsePage } from '/src/products/roadmap/browse/BrowsePage.jsx';
const root = createRoot(document.getElementById('fixture'));
window.mount = () => flushSync(() => root.render(React.createElement(BrowsePage)));
window.unmount = () => flushSync(() => root.render(null));
`;
      },
      configureServer(vite) {
        vite.middlewares.use('/gallery-reads-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><html data-brand="roadmap" data-theme="light"><body><div id="fixture"></div><script type="module" src="/gallery-reads-entry.js"></script></body></html>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', hmr: false } });
  t.after(async () => { await server.close(); await rm(cacheDir, { recursive: true, force: true }); });
  const ready = once(server.httpServer, 'listening', { signal: AbortSignal.timeout(15000) });
  server.httpServer.listen(0, '127.0.0.1');
  await ready;
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const canary = 'gallery-sensitive-canary';
  const first = { id: `${canary}-id`, title: `${canary}-title`, sourceTitle: `${canary}-source`, done: 1, total: 3 };
  const second = { id: `${canary}-second-id`, title: `${canary}-second-title` };
  const cursor = `${canary}-cursor?token=private`;
  const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

  for (const engine of [chromium, webkit]) {
    await t.test(engine.name(), { timeout: 80000 }, async (suite) => {
      const browser = await engine.launch({ headless: true });
      suite.after(() => browser.close());

      async function withGallery(answer, run) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        page.setDefaultNavigationTimeout(15000);
        const errors = [];
        const bodies = [];
        const events = [];
        const issues = [];
        const requests = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('https://errors.example/**', async (route) => {
          const body = route.request().postData();
          bodies.push(body);
          const event = JSON.parse(body.split('\n')[2]);
          issues.push({ operation: event.exception.values[0].value, route: event.request.url, tags: event.tags });
          await route.fulfill({ status: 200 });
        });
        await page.route('**/v1/events', async (route) => {
          const body = route.request().postData();
          bodies.push(body);
          events.push(...JSON.parse(body).events.map(({ name, props }) => ({ name, props })));
          await route.fulfill({ status: 204 });
        });
        await page.route('**/og/*.png', (route) => route.fulfill({ status: 204 }));
        await page.route('**/v1/gallery?*', async (route) => {
          requests.push(new URL(route.request().url()).searchParams.get('cursor'));
          const response = await answer(requests.length, route);
          if (response === 'abort') await route.abort('failed');
          else if (response) await route.fulfill(response);
        });
        try {
          await page.goto(`${origin}/gallery-reads-test#/${canary}`);
          await page.waitForFunction(() => typeof window.mount === 'function');
          const telemetry = async () => {
            await page.evaluate(() => {
              Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
              window.dispatchEvent(new Event('online'));
            });
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            return { issues, events };
          };
          await run({ page, requests, telemetry });
          assert.deepEqual(errors, []);
          assert.equal(bodies.join('\n').includes(canary), false, 'no response, cursor, title, id or page URL leaves in telemetry');
        } finally {
          await context.close();
        }
      }

      await suite.test('initial 500 reports once, then Retry emits one press and a successful result', async () => {
        await withGallery((attempt) => attempt === 1 ? json({ error: canary }, 500) : json({ count: 1, entries: [first] }), async ({ page, requests, telemetry }) => {
          await page.evaluate(() => window.mount());
          await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
          assert.equal(await page.locator('.wm-br-quiet p').innerText(), 'Can’t reach the gallery just now.');
          assert.deepEqual(await telemetry(), {
            issues: [{ operation: 'roadmap-gallery-load', route: '#/app', tags: { read: 'initial', reason: 'server', kind: 'roadmap' } }],
            events: [{ name: 'roadmap_gallery', props: { step: 'load', outcome: 'failed' } }],
          });
          await page.getByRole('button', { name: 'Try again', exact: true }).click();
          await page.getByRole('link', { name: first.title, exact: true }).waitFor();
          assert.deepEqual(requests, [null, null]);
          assert.deepEqual(await telemetry(), {
            issues: [{ operation: 'roadmap-gallery-load', route: '#/app', tags: { read: 'initial', reason: 'server', kind: 'roadmap' } }],
            events: [
              { name: 'roadmap_gallery', props: { step: 'load', outcome: 'failed' } },
              { name: 'roadmap_gallery', props: { step: 'retry', read: 'initial' } },
              { name: 'roadmap_gallery', props: { step: 'load', outcome: 'available' } },
            ],
          });
        });
      });

      await suite.test('page 500 keeps cards, count and cursor; Retry appends without duplicates or another more press', async () => {
        await withGallery((attempt) => {
          if (attempt === 1) return json({ count: 7, entries: [first], nextCursor: cursor });
          if (attempt === 2) return json({ error: canary }, 500);
          return json({ count: 7, entries: [first, second], nextCursor: '' });
        }, async ({ page, requests, telemetry }) => {
          await page.evaluate(() => window.mount());
          await page.getByRole('button', { name: 'Show more trees', exact: true }).click();
          await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
          assert.deepEqual(await page.locator('.wm-br-card .wm-gc-open').allTextContents(), [first.title]);
          assert.equal(await page.locator('.wm-br-line > span').innerText(), '7 trees planted in public');
          await page.getByRole('button', { name: 'Try again', exact: true }).click();
          await page.getByRole('link', { name: second.title, exact: true }).waitFor();
          assert.deepEqual(await page.locator('.wm-br-card .wm-gc-open').allTextContents(), [first.title, second.title]);
          assert.equal(await page.locator('.wm-br-line > span').innerText(), '7 trees planted in public');
          assert.equal(await page.locator('.wm-br-more').count(), 0);
          assert.deepEqual(requests, [null, cursor, cursor]);
          assert.deepEqual(await telemetry(), {
            issues: [{ operation: 'roadmap-gallery-load', route: '#/app', tags: { read: 'page', reason: 'server', kind: 'roadmap' } }],
            events: [
              { name: 'roadmap_gallery', props: { step: 'load', outcome: 'available' } },
              { name: 'roadmap_gallery', props: { step: 'more', read: 'page' } },
              { name: 'roadmap_gallery', props: { step: 'page', outcome: 'failed' } },
              { name: 'roadmap_gallery', props: { step: 'retry', read: 'page' } },
              { name: 'roadmap_gallery', props: { step: 'page', outcome: 'available' } },
            ],
          });
        });
      });

      for (const read of ['initial', 'page']) {
        for (const [name, response, state, reason] of [
          ['401', json({ error: canary }, 401), 'visible', null],
          ['403', json({ error: canary }, 403), 'visible', null],
          ['429', json({ error: canary }, 429), 'visible', null],
          ['online transport', 'abort', 'visible', 'network'],
          ['offline transport', 'abort', 'offline', null],
          ['hidden transport', 'abort', 'hidden', null],
          ['invalid JSON', { status: 200, contentType: 'application/json', body: canary }, 'visible', 'shape'],
          ['projection failure', json({ entries: { private: canary } }), 'visible', 'shape'],
        ]) {
          await suite.test(`${read} ${name} emits failed and ${reason ? `reports ${reason}` : 'does not report'}`, async () => {
            await withGallery((attempt) => read === 'page' && attempt === 1 ? json({ count: 7, entries: [first], nextCursor: cursor }) : response, async ({ page, telemetry }) => {
              if (read === 'page') {
                await page.evaluate(() => window.mount());
                await page.getByRole('button', { name: 'Show more trees', exact: true }).waitFor();
              }
              if (state !== 'visible') await page.evaluate((value) => {
                if (value === 'offline') Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
                else Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
              }, state);
              if (read === 'page') await page.getByRole('button', { name: 'Show more trees', exact: true }).click();
              else await page.evaluate(() => window.mount());
              await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
              assert.deepEqual(await telemetry(), {
                issues: reason ? [{ operation: 'roadmap-gallery-load', route: '#/app', tags: { read, reason, kind: 'roadmap' } }] : [],
                events: [
                  ...(read === 'page' ? [
                    { name: 'roadmap_gallery', props: { step: 'load', outcome: 'available' } },
                    { name: 'roadmap_gallery', props: { step: 'more', read: 'page' } },
                  ] : []),
                  { name: 'roadmap_gallery', props: { step: read === 'initial' ? 'load' : 'page', outcome: 'failed' } },
                ],
              });
            });
          });
        }

        for (const response of [json({ error: canary }, 500), json({ entries: [second], count: 7 })]) {
          await suite.test(`late ${read} ${response.status} after unmount emits no result or report`, async () => {
            let reply;
            const held = new Promise((resolve) => { reply = resolve; });
            await withGallery(async (attempt) => {
              if (read === 'page' && attempt === 1) return json({ count: 7, entries: [first], nextCursor: cursor });
              await held;
              return response;
            }, async ({ page, telemetry }) => {
              const requested = page.waitForRequest((request) => {
                const url = new URL(request.url());
                return url.pathname === '/v1/gallery' && (read === 'initial' || url.searchParams.get('cursor') === cursor);
              });
              await page.evaluate(() => window.mount());
              if (read === 'page') await page.getByRole('button', { name: 'Show more trees', exact: true }).click();
              await requested;
              await page.evaluate(() => window.unmount());
              const finished = page.waitForEvent('requestfinished', (request) => request.url().includes('/v1/gallery?'));
              reply();
              await finished;
              assert.deepEqual(await telemetry(), {
                issues: [],
                events: read === 'page' ? [
                  { name: 'roadmap_gallery', props: { step: 'load', outcome: 'available' } },
                  { name: 'roadmap_gallery', props: { step: 'more', read: 'page' } },
                ] : [],
              });
              assert.equal(await page.locator('#fixture').innerHTML(), '');
            });
          });
        }
      }

      await suite.test('an omitted entries list stays a legitimate empty initial result', async () => {
        await withGallery(() => json({}), async ({ page, telemetry }) => {
          await page.evaluate(() => window.mount());
          await page.locator('.wm-br-bare').waitFor();
          assert.deepEqual(await telemetry(), {
            issues: [], events: [{ name: 'roadmap_gallery', props: { step: 'load', outcome: 'empty' } }],
          });
        });
      });

      await suite.test('an empty final page reports empty and preserves existing cards', async () => {
        await withGallery((attempt) => json(attempt === 1 ? { count: 1, entries: [first], nextCursor: cursor } : { count: 1, entries: [], nextCursor: '' }), async ({ page, telemetry }) => {
          await page.evaluate(() => window.mount());
          await page.getByRole('button', { name: 'Show more trees', exact: true }).click();
          await page.locator('.wm-br-more').waitFor({ state: 'detached' });
          assert.deepEqual(await page.locator('.wm-br-card .wm-gc-open').allTextContents(), [first.title]);
          assert.equal(await page.locator('.wm-br-bare').count(), 0);
          assert.deepEqual(await telemetry(), {
            issues: [], events: [
              { name: 'roadmap_gallery', props: { step: 'load', outcome: 'available' } },
              { name: 'roadmap_gallery', props: { step: 'more', read: 'page' } },
              { name: 'roadmap_gallery', props: { step: 'page', outcome: 'empty' } },
            ],
          });
        });
      });
    });
  }
});
