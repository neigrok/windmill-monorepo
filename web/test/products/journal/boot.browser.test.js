import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { hello } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { registry } from '../../../src/platform/sync/schema.js';
import { beacon, withBrowserErrors } from '../roadmap/browserFixture.js';

// The journal room as the app boots it: the real account provider, sign-in door and shell over the browser's own engine,
// its IndexedDB copy seeded by an earlier visit, and every `/v1` request the test's to answer or to hold.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import AuthProvider, { useAuth } from '/src/shell/auth/AuthProvider.jsx';
import { SignInDoorProvider } from '/src/shell/auth/SignInDoor.jsx';
import EntitlementsProvider from '/src/shell/billing/EntitlementsProvider.jsx';
import { Shell } from '/src/shell/chrome/Shell.jsx';
import { BrowserSyncEngine } from '/src/platform/sync/engine.js';
import { registry } from '/src/platform/sync/schema.js';
import { syncSession } from '/src/platform/sync/session.js';
import { localDay } from '/src/products/journal/localDay.js';
import '/src/styles/global.css';

const dayBefore = (days) => {
  const at = new Date(localDay() + 'T12:00:00');
  at.setDate(at.getDate() - days);
  return at.toISOString().slice(0, 10);
};

// A visit of this browser's, in this tab or another: it signs \`account\` in, after signing out whoever it held, and leaves
// its pages, \`daysAgo\` before today, in the browser's copy.
window.seed = async ({ response, pages, account, signOutFirst = false }) => {
  const timing = { send: { wall: Date.now(), mono: 0, boot: 'seed' }, recv: { wall: Date.now(), mono: 0, boot: 'seed' } };
  const engine = await BrowserSyncEngine.open({ registry, document: null, window: null,
    navigator: { onLine: false, locks: navigator.locks, storage: navigator.storage },
    transport: { request: async () => ({ response, timing }) }, telemetry: { failure() {}, event() {} } });
  if (signOutFirst) {
    await engine.beginSignOut();
    await engine.finishSignOut({ choice: 'keep' });
  }
  await engine.signIn(account);
  const stamp = '1:0:srv';
  await engine.write(null, (device) => {
    pages.forEach(({ daysAgo, text }, index) => device.activeReplica.putConfirmed('self/journal', { t: 'page', id: dayBefore(daysAgo),
      seq: index + 1, rc: 1, ru: 1, x: { body: { text, rev: 1, base: null } },
      f: { mood: [null, stamp], energy: [null, stamp], source: ['typed', stamp], documentStamp: [{ ms: 1, counter: 0, actor: 'srv' }, stamp] } }));
    device.activeReplica.cursors['self/journal'] = { ...device.activeReplica.cursorOf('self/journal'), booted: true };
  }, ['self/journal']);
  engine.close();
};

function Seat() {
  const { status } = useAuth();
  return React.createElement('output', { id: 'auth-state' }, status);
}

window.mount = () => {
  window.replica = () => syncSession.engine?.getSnapshot() ?? null;
  createRoot(document.getElementById('root')).render(React.createElement(AuthProvider, null,
    React.createElement(EntitlementsProvider, null, React.createElement(SignInDoorProvider, null, React.createElement(Seat),
      React.createElement(Shell, { location: { pathname: '/app/journal', hash: '#/journal', search: '' } })))));
};
window.entryReady = true;
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-journal-boot-test`,
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('') },
    plugins: [{ name: 'journal-boot-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/journal-boot-entry.js') return '\0journal-boot-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0journal-boot-events';
        if (id.endsWith('/telemetry/sentry.js')) return '\0journal-boot-issues';
      },
      load(id) {
        if (id === '\0journal-boot-entry') return entry;
        if (id === '\0journal-boot-events') return beacon;
        if (id === '\0journal-boot-issues') return 'export function captureError(product, operation) { (window.issues ??= []).push(operation); }';
      },
      configureServer(server) {
        server.middlewares.use('/journal-boot', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Journal boot test</title><div id="root"></div><script type="module" src="/journal-boot-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => {
  try { await ready; } finally { await browser?.close(); await server?.close(); }
});

const words = (account, day) => `${account} wrote on day ${day}. ${'The evening was long and quiet, and the words kept coming. '.repeat(8)}`;

// A visit of `account`'s that leaves its pages of the last twelve days in the browser's copy, from `page`, the tab under
// test or another.
function visit(page, account, { signOutFirst = false } = {}) {
  return page.evaluate((seed) => window.seed(seed), {
    account, signOutFirst,
    response: hello({ state: ServerState.empty({ epoch: 'journal-boot', accounts: { A: { name: 'A' }, B: { name: 'B' } } }), registry, account, serverTime: Date.now() }),
    pages: Array.from({ length: 12 }, (_, index) => ({ daysAgo: index + 1, text: words(account, index + 1) })),
  });
}

// One visit of account A's, then a fresh document whose `/v1/me` answers A and its sync hello. Every other `/v1` request
// is held.
async function boot(t, { height = 1000 } = {}) {
  await ready;
  const context = await browser.newContext({ viewport: { width: 1440, height } });
  context.setDefaultTimeout(20000);
  t.after(() => context.close());
  await context.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/me') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":{"id":"A","name":"Ann"}}' });
    if (path === '/v1/sync/hello') return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(hello({ state: ServerState.empty({ epoch: 'journal-boot', accounts: { A: { name: 'A' } } }), registry, account: 'A', serverTime: Date.now() }).body) });
    return undefined;
  });
  const page = await context.newPage();
  await withBrowserErrors(page, async () => {
    await page.goto(`${origin}/journal-boot#/journal`);
    await page.waitForFunction(() => window.entryReady);
    await visit(page, 'A');
    await page.reload();
    await page.waitForFunction(() => window.entryReady);
    await page.evaluate(() => window.mount());
    await page.waitForFunction(() => document.getElementById('auth-state').textContent === 'signed-in');
    await page.getByText('A wrote on day 1.').waitFor();
  });
  return { context, page };
}

test('Chromium: another tab’s account is not drawn under this tab’s: the journal draws nothing of it while the shell catches up', async (t) => {
  const { context, page } = await boot(t);
  await withBrowserErrors(page, async () => {
    await page.evaluate(() => {
      window.sawOther = false;
      const seen = () => { if (document.body.textContent.includes('B wrote') || document.querySelector('textarea')?.value.includes('B wrote')) window.sawOther = true; };
      new MutationObserver(seen).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    });
    const other = await context.newPage();
    await other.goto(`${origin}/journal-boot#/journal`);
    await other.waitForFunction(() => window.entryReady);
    await visit(other, 'B', { signOutFirst: true });
    // Well inside the shell's 20 s account poll, which would sign A back in.
    await page.getByText('A wrote on day 1.').waitFor({ state: 'detached', timeout: 5000 });
    await page.waitForTimeout(1000);
    assert.deepEqual(await page.evaluate(() => ({ seat: document.getElementById('auth-state').textContent, bound: window.replica().account,
      sawOther: window.sawOther, days: document.querySelectorAll('.journal-day:not(.journal-today)').length,
      today: document.querySelector('textarea.journal-input').value, issues: window.issues ?? [] })),
    { seat: 'signed-in', bound: 'B', sawOther: false, days: 0, today: '', issues: [] });
  });
});

test('Chromium: a page restored from the back/forward cache keeps the canvas, what was typed and its scroll, and saves it once restored', async (t) => {
  const { page } = await boot(t, { height: 600 });
  await withBrowserErrors(page, async () => {
    const field = page.getByRole('textbox', { name: 'Write today' });
    await field.fill('Typed before the page was cached');
    const box = await page.locator('.journal-scroll').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -1500);
    await page.waitForFunction(() => {
      const scroller = document.querySelector('.journal-scroll');
      return scroller.scrollTop > 0 && scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight - 1000;
    });
    await page.evaluate(() => new Promise((settled) => setTimeout(settled, 300)));
    const before = await page.evaluate(() => {
      window.canvasBefore = document.querySelector('.journal-scroll');
      return window.canvasBefore.scrollTop;
    });
    const restored = await page.evaluate(async () => {
      const { syncSession } = await import('/src/platform/sync/session.js');
      const { engine } = syncSession;
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      // The typed burst's save comes due while the engine is suspended.
      await new Promise((resolve) => setTimeout(resolve, 800));
      const suspended = { closed: engine.closed, entries: engine.device.activeReplica.entries('self/journal').length,
        sameCanvas: document.querySelector('.journal-scroll') === window.canvasBefore };
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      await engine.restoring;
      await new Promise((frame) => requestAnimationFrame(() => setTimeout(frame, 50)));
      const scroller = document.querySelector('.journal-scroll');
      return { suspended, sameCanvas: scroller === window.canvasBefore, closed: engine.closed, scrollTop: scroller.scrollTop,
        typed: document.querySelector('textarea.journal-input').value };
    });
    assert.deepEqual(restored, { suspended: { closed: true, entries: 0, sameCanvas: true }, sameCanvas: true, closed: false,
      scrollTop: before, typed: 'Typed before the page was cached' });
    await page.waitForFunction(async () => {
      const { syncSession } = await import('/src/platform/sync/session.js');
      return syncSession.engine.device.activeReplica.entries('self/journal')
        .some((entry) => entry.intent.cmd?.args.body === 'Typed before the page was cached');
    });
    assert.deepEqual(await page.evaluate(() => window.issues ?? []), []);
  });
});
