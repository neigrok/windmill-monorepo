import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from '../../products/roadmap/board/composerFixture.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const offline = { line: 'Offline · changes will sync', short: 'Offline', icon: 'offline', narrow: 'icon' };
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from '/src/shell/chrome/Shell.jsx';
import { publishRoomStatus } from '/src/shell/roomStatus.js';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
window.publish = publishRoomStatus;
createRoot(document.getElementById('root')).render(React.createElement(Shell, {
  location: { pathname: '/app', hash: '', search: '' },
  neutral: { Component: () => React.createElement('button', { id: 'outside' }, 'Outside') },
}));
`;
let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-shell-status-test`,
    plugins: [{ name: 'shell-status-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/shell-status-entry.js') return '\0shell-status-entry';
        if (id.endsWith('/auth/AuthProvider.jsx')) return '\0shell-status-auth';
        if (id.endsWith('/auth/SignInDoor.jsx')) return '\0shell-status-door';
        if (id.endsWith('/telemetry/beacon.js')) return '\0shell-status-events';
      },
      load(id) {
        if (id === '\0shell-status-entry') return entry;
        if (id === '\0shell-status-auth') return `export const useAuth = () => ({ status: location.search.includes('ghost') ? 'ghost' : 'signed-in', user: location.search.includes('ghost') ? null : { name: 'Ada' }, signOut() {} });`;
        if (id === '\0shell-status-door') return `export const useSignInDoor = () => () => { window.signInOpened = true; }; export const useSignInDoorHost = () => () => {};`;
        if (id === '\0shell-status-events') return beacon;
      },
      configureServer(vite) {
        vite.middlewares.use('/shell-status-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/shell-status-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../', import.meta.url))] } },
  });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
ready.catch(() => {});
after(async () => { await browser?.close(); await server?.close(); });

async function visit(t, width, run, query = '') {
  await ready;
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  t.after(() => page.close());
  await withBrowserErrors(page, async () => {
    await page.goto(`${origin}/shell-status-test${query}`);
    await page.locator('.wm-head-seat button').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await run(page);
  });
}

test('unpublished status leaves the entire header unchanged after a room clears', async (t) => {
  await visit(t, 1440, async (page) => {
    const before = await page.locator('.wm-head').evaluate((element) => element.outerHTML);
    assert.equal(await page.locator('.wm-room-status').count(), 0);
    await page.evaluate((status) => { window.releaseStatus = window.publish(status); }, offline);
    await page.locator('.wm-room-status').waitFor();
    await page.evaluate(() => window.releaseStatus());
    await page.locator('.wm-room-status').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.wm-head').evaluate((element) => element.outerHTML), before);
  });
});

for (const width of [1440, 744, 390, 320]) {
  test(`the Shell status has the drawn form, full announcement and visible seat at ${width}`, async (t) => {
    await visit(t, width, async (page) => {
      await page.evaluate((status) => window.publish(status), offline);
      await page.locator('.wm-room-status').waitFor();
      assert.equal(await page.getByRole('status').getAttribute('aria-label'), offline.line);
      assert.equal(await page.getByRole('status').textContent(), offline.line);
      assert.equal(await page.locator('.wm-room-status-full').isVisible(), width >= 744);
      assert.equal(await page.locator('.wm-room-status-compact').isVisible(), width >= 360 && width < 744);
      assert.equal(await page.locator('.wm-room-status-tap').isVisible(), width < 360);
      const seat = await page.locator('.wm-head-seat').boundingBox();
      assert.equal(seat.x >= 0 && seat.x + seat.width <= width, true);
      const nav = await page.locator('.wm-switch').boundingBox();
      const slot = await page.locator('.wm-room-status').boundingBox();
      assert.equal(nav.x + nav.width <= slot.x, true);
      for (const line of ['Saving…', 'Saved']) {
        await page.evaluate((line) => window.publish({ line, narrow: 'announce' }), line);
        await page.getByRole('status', { name: line, exact: true }).waitFor();
        assert.equal(await page.locator('.wm-room-status-compact').isVisible(), width >= 360 && width < 744);
        assert.equal(await page.locator('.wm-room-status-full').isVisible(), width >= 744);
        assert.equal(await page.locator('.wm-room-status-announcement').evaluate((element) => getComputedStyle(element).clipPath), 'inset(50%)');
      }
    });
  });
}

test('the icon tooltip closes after four seconds, a second tap, and an outside tap', async (t) => {
  await visit(t, 320, async (page) => {
    const start = new Date('2026-11-03T12:00:00Z');
    await page.clock.install({ time: new Date(start.getTime() - 60000) });
    await page.clock.pauseAt(start);
    await page.evaluate((status) => window.publish(status), offline);
    const tap = page.getByRole('button', { name: offline.line, exact: true });
    await tap.click();
    await page.getByRole('tooltip').waitFor();
    assert.equal(await page.getByRole('tooltip').textContent(), offline.line);
    const box = await page.getByRole('tooltip').boundingBox();
    assert.equal(box.x >= 0 && box.x + box.width <= 320, true);
    await page.clock.runFor(3999);
    assert.equal(await page.getByRole('tooltip').count(), 1);
    await page.clock.runFor(1);
    await page.getByRole('tooltip').waitFor({ state: 'detached' });
    await tap.click();
    await page.getByRole('tooltip').waitFor();
    await tap.click();
    await page.getByRole('tooltip').waitFor({ state: 'detached' });
    await tap.click();
    await page.getByRole('tooltip').waitFor();
    await page.locator('#outside').click();
    await page.getByRole('tooltip').waitFor({ state: 'detached' });
  });
});

test('the live region stays mounted across status changes and equal publication makes no mutation', async (t) => {
  await visit(t, 744, async (page) => {
    await page.evaluate(() => window.publish({ line: 'Saving…', narrow: 'announce' }));
    await page.getByRole('status', { name: 'Saving…', exact: true }).waitFor();
    await page.evaluate(() => {
      window.liveRegion = document.querySelector('[role="status"]');
      window.mutations = [];
      new MutationObserver((records) => window.mutations.push(...records.map((record) => record.type)))
        .observe(window.liveRegion, { attributes: true, childList: true, characterData: true, subtree: true });
      window.publish({ line: 'Saved', narrow: 'announce' });
    });
    await page.getByRole('status', { name: 'Saved', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.liveRegion === document.querySelector('[role="status"]')), true);
    await page.evaluate(() => { window.mutations = []; window.publish({ line: 'Saved', narrow: 'announce' }); });
    assert.deepEqual(await page.evaluate(() => window.mutations), []);
  });
});

test('the longest device line and account seat fit together at 744', async (t) => {
  await visit(t, 744, async (page) => {
    const line = 'Saved on this device — sign in to keep it';
    await page.evaluate((line) => window.publish({ line }), line);
    await page.getByRole('status', { name: line, exact: true }).waitFor();
    const nav = await page.locator('.wm-switch').boundingBox();
    const slot = await page.locator('.wm-room-status').boundingBox();
    const seat = await page.locator('.wm-head-seat').boundingBox();
    assert.equal(nav.x + nav.width <= slot.x, true);
    assert.equal(slot.x + slot.width <= seat.x, true);
    assert.equal(seat.x + seat.width <= 744, true);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    assert.equal(await page.evaluate(() => window.signInOpened), true);
  }, '?ghost');
});
