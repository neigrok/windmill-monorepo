import { SYNC_STATUS, SYNC_OFFLINE_SHORT, ANONYMOUS_OWNER } from '../../../src/products/roadmap/copy.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from '../../products/roadmap/browserFixture.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const offline = { line: SYNC_STATUS.offline, short: SYNC_OFFLINE_SHORT, icon: 'offline', narrow: 'icon' };
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from '/src/shell/chrome/Shell.jsx';
import { registerRoomStatus } from '/src/shell/roomStatus.js';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
window.publish = (status) => {
  window.statusLease ??= registerRoomStatus();
  window.statusLease.publish(status);
  return () => { window.statusLease.release(); window.statusLease = null; };
};
const outside = () => React.createElement('button', { id: 'outside' }, 'Outside');
const sharedRoom = { id: 'roadmap', label: 'Roadmap', shell: { scope: { theme: null, brand: 'roadmap' }, sharedShell: true },
  render: () => ({ Component: outside, props: {} }), home: () => '' };
createRoot(document.getElementById('root')).render(React.createElement(Shell, location.search.includes('shared')
  ? { location: { pathname: '/', hash: '#/demo', search: '' }, roomProduct: sharedRoom }
  : { location: { pathname: '/app', hash: '', search: '' }, neutral: { Component: outside } }));
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
      assert.equal(await page.getByRole('status').getAttribute('aria-label'), null);
      assert.equal(await page.getByRole('status').textContent(), offline.line);
      assert.equal(await page.locator('.wm-room-status-full').isVisible(), width >= 744);
      assert.equal(await page.locator('.wm-room-status-compact').isVisible(), width >= 360 && width < 744);
      assert.equal(await page.locator('.wm-room-status-tap').isVisible(), width < 360);
      const seat = await page.locator('.wm-head-seat').boundingBox();
      assert.equal(seat.x >= 0 && seat.x + seat.width <= width, true);
      const nav = await page.locator('.wm-switch').boundingBox();
      const slot = await page.locator('.wm-room-status').boundingBox();
      assert.equal(nav.x + nav.width <= slot.x, true);
      for (const line of [SYNC_STATUS.saving, SYNC_STATUS.saved]) {
        await page.evaluate((line) => window.publish({ line, narrow: 'announce' }), line);
        await page.waitForFunction((line) => document.querySelector('[role="status"]')?.textContent === line, line);
        assert.equal(await page.locator('.wm-room-status-compact').isVisible(), width >= 360 && width < 744);
        assert.equal(await page.locator('.wm-room-status-full').isVisible(), width >= 744);
        assert.equal(await page.locator('.wm-room-status-announcement').evaluate((element) => getComputedStyle(element).clipPath), 'inset(50%)');
      }
    });
  });
}

for (const width of [390, 320]) {
  test(`a Shared Shell room with no status draws no mark, the links from the edge and Sign in at the far end at ${width}`, async (t) => {
    await visit(t, width, async (page) => {
      assert.deepEqual(await page.evaluate(() => {
        const nav = document.querySelector('.wm-switch').getBoundingClientRect();
        const home = document.querySelector('.wm-switch-btn').getBoundingClientRect();
        const signIn = document.querySelector('.wm-head-sign-in').getBoundingClientRect();
        return {
          mark: getComputedStyle(document.querySelector('.wm-head-mark')).display,
          navLeft: nav.left,
          linkPadding: getComputedStyle(document.querySelector('.wm-switch-btn')).paddingInlineStart,
          homeHeight: home.height,
          activeFill: getComputedStyle(document.querySelector('.wm-switch-btn[aria-current="page"]')).backgroundColor,
          signInRight: signIn.right,
          clear: nav.right <= signIn.left,
          overflow: document.documentElement.scrollWidth > innerWidth,
          slots: document.querySelectorAll('.wm-room-status').length,
          liveRegions: document.querySelectorAll('[role="status"]').length,
        };
      }), { mark: 'none', navLeft: 16, linkPadding: '6px', homeHeight: 30, activeFill: 'rgba(0, 0, 0, 0)', signInRight: width - 16, clear: true, overflow: false, slots: 0, liveRegions: 0 });
    }, '?ghost&shared');
  });
}

for (const width of [390, 320]) {
  test(`a Shared Shell room's status keeps its links clear and its seat inside the page at ${width}`, async (t) => {
    await visit(t, width, async (page) => {
      await page.evaluate((status) => window.publish(status), offline);
      await page.locator('.wm-room-status').waitFor();
      assert.deepEqual(await page.evaluate(() => {
        const nav = document.querySelector('.wm-switch').getBoundingClientRect();
        const slot = document.querySelector('.wm-room-status').getBoundingClientRect();
        const seat = document.querySelector('.wm-head-seat').getBoundingClientRect();
        return { navLeft: nav.left, clear: nav.right <= slot.left, seatRight: seat.right, overflow: document.documentElement.scrollWidth > innerWidth };
      }), { navLeft: 16, clear: true, seatRight: width - 16, overflow: false });
    }, '?shared');
  });
}

test('from 744 a Shared Shell room keeps the mark it shares with every room', async (t) => {
  await visit(t, 744, async (page) => {
    assert.equal(await page.locator('.wm-head-mark').evaluate((element) => getComputedStyle(element).display), 'flex');
  }, '?ghost&shared');
});

test('the icon tooltip closes after four seconds, a second tap, and an outside tap', async (t) => {
  await visit(t, 320, async (page) => {
    const start = new Date('2026-11-03T12:00:00Z');
    await page.clock.install({ time: new Date(start.getTime() - 60000) });
    await page.clock.pauseAt(start);
    await page.evaluate((status) => window.publish(status), offline);
    const tap = page.getByRole('button', { name: offline.line, exact: true });
    await tap.click();
    await page.getByRole('tooltip').waitFor();
    assert.equal(await tap.getAttribute('aria-describedby'), null);
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
    await page.evaluate((line) => window.publish({ line, narrow: 'announce' }), SYNC_STATUS.saving);
    await page.waitForFunction((line) => document.querySelector('[role="status"]')?.textContent === line, SYNC_STATUS.saving);
    await page.evaluate((line) => {
      window.liveRegion = document.querySelector('[role="status"]');
      window.mutations = [];
      new MutationObserver((records) => window.mutations.push(...records.map((record) => record.type)))
        .observe(window.liveRegion, { attributes: true, childList: true, characterData: true, subtree: true });
      window.publish({ line, narrow: 'announce' });
    }, SYNC_STATUS.saved);
    await page.waitForFunction((line) => document.querySelector('[role="status"]')?.textContent === line, SYNC_STATUS.saved);
    assert.equal(await page.evaluate(() => window.liveRegion === document.querySelector('[role="status"]')), true);
    await page.evaluate((line) => { window.mutations = []; window.publish({ line, narrow: 'announce' }); }, SYNC_STATUS.saved);
    assert.deepEqual(await page.evaluate(() => window.mutations), []);
  });
});

test('the longest device line and account seat fit together at 744', async (t) => {
  await visit(t, 744, async (page) => {
    const line = ANONYMOUS_OWNER;
    await page.evaluate((line) => window.publish({ line }), line);
    await page.waitForFunction((line) => document.querySelector('[role="status"]')?.textContent === line, line);
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


for (const width of [390, 320]) {
  test(`registered idle, saving, saved and offline states keep the same phone chrome at ${width}`, async (t) => {
    await visit(t, width, async (page) => {
      await page.evaluate(() => window.publish(null));
      await page.getByRole('status').waitFor({ state: 'attached' });
      const geometry = () => page.evaluate(() => {
        const box = (selector) => {
          const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          mark: getComputedStyle(document.querySelector('.wm-head-mark')).display,
          nav: box('.wm-switch'), slot: box('.wm-room-status'), seat: box('.wm-head-seat'),
        };
      });
      const idle = await geometry();
      assert.equal(idle.mark, 'none');
      assert.equal(idle.slot.width, width < 360 ? 44 : 72);
      await page.evaluate(() => { window.originalRegion = document.querySelector('[role="status"]'); });
      for (const status of [{ line: SYNC_STATUS.saving, narrow: 'announce' }, { line: SYNC_STATUS.saved, narrow: 'announce' }, null, offline, null]) {
        await page.evaluate((status) => window.publish(status), status);
        await page.waitForFunction((line) => document.querySelector('[role="status"]')?.textContent === line, status?.line ?? '');
        assert.deepEqual(await geometry(), idle);
        assert.equal(await page.evaluate(() => window.originalRegion === document.querySelector('[role="status"]')), true);
      }
    });
  });
}

for (const status of [offline, { line: ANONYMOUS_OWNER }]) {
  test(`first publication ${status.line} adds text to an already committed live region`, async (t) => {
    await visit(t, 744, async (page) => {
      await page.evaluate((status) => {
        window.announcementChanges = [];
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.target.nodeType !== Node.ELEMENT_NODE || record.target.getAttribute('role') !== 'status') continue;
            window.announcementChanges.push({
              type: record.type,
              added: [...record.addedNodes].map((node) => ({ type: node.nodeType, text: node.textContent })),
            });
          }
        });
        observer.observe(document.querySelector('.wm-head'), { childList: true, subtree: true });
        window.publish(status);
      }, status);
      await page.waitForFunction((line) => document.querySelector('[role="status"]')?.textContent === line, status.line);
      assert.deepEqual(await page.evaluate(() => window.announcementChanges), [
        { type: 'childList', added: [{ type: 3, text: status.line }] },
      ]);
    });
  });
}


for (const width of [744, 1440]) {
  for (const query of ['', '?ghost']) {
    test(`registered desktop room links stay fixed through every status at ${width} ${query}`, async (t) => {
      await visit(t, width, async (page) => {
        await page.evaluate(() => window.publish(null));
        await page.locator('.wm-room-status').waitFor({ state: 'attached' });
        const navigation = await page.locator('.wm-switch').boundingBox();
        for (const status of [{ line: SYNC_STATUS.saving }, { line: SYNC_STATUS.saved }, offline, { line: ANONYMOUS_OWNER }, null]) {
          await page.evaluate((status) => window.publish(status), status);
          await page.waitForFunction((line) => document.querySelector('.wm-room-status-full')?.textContent === line, status?.line ?? '');
          assert.deepEqual(await page.locator('.wm-switch').boundingBox(), navigation);
          assert.deepEqual(await page.evaluate(() => {
            const nav = document.querySelector('.wm-switch').getBoundingClientRect();
            const slot = document.querySelector('.wm-room-status').getBoundingClientRect();
            const seat = document.querySelector('.wm-head-seat').getBoundingClientRect();
            const line = document.querySelector('.wm-room-status-full').getBoundingClientRect();
            return { navClear: nav.right <= slot.left, seatClear: slot.right <= seat.left,
              lineFits: line.width <= slot.width, seatFits: seat.right <= innerWidth };
          }), { navClear: true, seatClear: true, lineFits: true, seatFits: true });
        }
      }, query);
    });
  }
}
