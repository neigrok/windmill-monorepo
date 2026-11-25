import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { hello } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { registry } from '../../../src/platform/sync/schema.js';
import { beacon, withBrowserErrors } from '../roadmap/browserFixture.js';

// The gym room as the app boots it: the real account provider, sign-in door and shell over the browser's own engine, its
// IndexedDB copy seeded by an earlier visit, and every `/v1` request the test's to answer or to hold.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import AuthProvider, { useAuth } from '/src/shell/auth/AuthProvider.jsx';
import { SignInDoorProvider } from '/src/shell/auth/SignInDoor.jsx';
import { Shell } from '/src/shell/chrome/Shell.jsx';
import { BrowserSyncEngine } from '/src/platform/sync/engine.js';
import { registry } from '/src/platform/sync/schema.js';
import { syncSession } from '/src/platform/sync/session.js';
import { reidentify } from '/@fs${repo}packages/api-contract/sync/reference/client/lifecycle.js';
import '/src/styles/global.css';

// A visit of this browser's, in this tab or another: it signs \`account\` in, after signing out whoever it held.
window.seed = async ({ response, rows, account = 'A', signOutFirst = false }) => {
  const timing = { send: { wall: Date.now(), mono: 0, boot: 'seed' }, recv: { wall: Date.now(), mono: 0, boot: 'seed' } };
  const engine = await BrowserSyncEngine.open({ registry, document: null, window: null,
    navigator: { onLine: false, locks: navigator.locks, storage: navigator.storage },
    transport: { request: async () => ({ response, timing }) }, telemetry: { failure() {}, event() {} } });
  if (signOutFirst) {
    await engine.beginSignOut();
    await engine.finishSignOut({ choice: 'keep' });
  }
  await engine.signIn(account);
  await engine.write(null, (device) => {
    rows.forEach((row, index) => device.activeReplica.putConfirmed('self/gym', { ...row, seq: index + 1 }));
    device.activeReplica.cursors['self/gym'] = { ...device.activeReplica.cursorOf('self/gym'), booted: true };
  }, ['self/gym']);
  engine.close();
};

// The server's answer to this replica moved on, as a push refused \`replica-forked\` moves it: same account, a new wire id.
window.reidentify = () => syncSession.engine.write(null, (device, context) => reidentify(device.activeReplica, context));

function Seat() {
  const { status } = useAuth();
  return React.createElement('output', { id: 'auth-state' }, status);
}

window.mount = (hash = '#/gym') => {
  window.mountedAt = performance.now();
  const drew = new MutationObserver(() => {
    if (!document.querySelector('.gym-routine-name')) return;
    window.drew = { at: performance.now(), status: document.getElementById('auth-state')?.textContent };
    drew.disconnect();
  });
  drew.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.replica = () => syncSession.engine?.getSnapshot() ?? null;
  createRoot(document.getElementById('root')).render(React.createElement(AuthProvider, null,
    React.createElement(SignInDoorProvider, null, React.createElement(Seat),
      React.createElement(Shell, { location: { pathname: '/app/gym', hash, search: '' } }))));
};
window.entryReady = true;
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-gym-boot-test`,
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('') },
    plugins: [{ name: 'gym-boot-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/gym-boot-entry.js') return '\0gym-boot-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0gym-boot-events';
        if (id.endsWith('/telemetry/sentry.js')) return '\0gym-boot-issues';
      },
      load(id) {
        if (id === '\0gym-boot-entry') return entry;
        if (id === '\0gym-boot-events') return beacon;
        if (id === '\0gym-boot-issues') return 'export function captureError(product, operation) { (window.issues ??= []).push(operation); }';
      },
      configureServer(server) {
        server.middlewares.use('/gym-boot', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Gym boot test</title><div id="root"></div><script type="module" src="/gym-boot-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => {
  try { await ready; } finally { await browser?.close(); await server?.close(); }
});

// A visit of `account`'s that leaves its routine in the browser's copy, from `page`, the tab under test or another.
function visit(page, account, { signOutFirst = false } = {}) {
  const stamp = '1:0:srv';
  return page.evaluate((seed) => window.seed(seed), {
    account, signOutFirst,
    response: hello({ state: ServerState.empty({ epoch: 'gym-boot', accounts: { A: { name: 'A' }, B: { name: 'B' } } }), registry, account, serverTime: Date.now() }),
    rows: [{ t: 'routine', id: `routineBoot${account}`, born: stamp, life: ['alive', stamp],
      f: { name: [`Held routine ${account}`, stamp], position: [0, stamp], entries: [[{ exerciseId: 'bench-press' }], stamp] } }],
  });
}

// One visit of account A's, then a fresh document at `hash` whose `/v1/me` is `me`: held (never answered), `nobody`,
// answering that no one is signed in, or `A`, answering A and its sync hello. Every other `/v1` request is held.
async function boot(t, { seeded, me, hash = '#/gym' }) {
  await ready;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(20000);
  t.after(() => context.close());
  const asked = [];
  await context.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    asked.push(path);
    if (path === '/v1/me' && me === 'nobody') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":null}' });
    if (path === '/v1/me' && me === 'A') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":{"id":"A","name":"Ann"}}' });
    if (path === '/v1/sync/hello' && me === 'A') return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(hello({ state: ServerState.empty({ epoch: 'gym-boot', accounts: { A: { name: 'A' } } }), registry, account: 'A', serverTime: Date.now() }).body) });
    return undefined;
  });
  const page = await context.newPage();
  await withBrowserErrors(page, async () => {
    await page.goto(`${origin}/gym-boot#/gym`);
    await page.waitForFunction(() => window.entryReady);
    if (seeded) {
      await visit(page, 'A');
      await page.reload();
      await page.waitForFunction(() => window.entryReady);
    }
    await page.evaluate((at) => window.mount(at), hash);
  });
  return { context, page, asked };
}

test('Chromium: the gym room draws from the browser’s copy while the account’s answer is held', async (t) => {
  const { page, asked } = await boot(t, { seeded: true, me: 'held' });
  await withBrowserErrors(page, async () => {
    await page.locator('.gym-routine-name').waitFor();
    const drew = await page.evaluate(() => ({ ms: Math.round(window.drew.at - window.mountedAt), status: window.drew.status }));
    t.diagnostic(`the room drew ${drew.ms} ms after mount, /v1/me unanswered`);
    assert.equal(drew.status, 'loading', 'the room drew before the account answered');
    assert.deepEqual(await page.locator('.gym-routine-name').allTextContents(), ['Held routine A']);
    assert.equal(await page.locator('#auth-state').textContent(), 'loading');
    assert.ok(asked.includes('/v1/me'), 'the account was asked for and is still unanswered');
    assert.deepEqual(await page.evaluate(() => [window.replica().state, window.issues ?? []]), ['bound', []]);
  });
});

test('Chromium: a paused session keeps the room, with sign-in at the account seat beside it', async (t) => {
  const { page } = await boot(t, { seeded: true, me: 'nobody' });
  await withBrowserErrors(page, async () => {
    await page.waitForFunction(() => document.getElementById('auth-state').textContent === 'ghost' && window.replica()?.authPaused === true);
    await page.locator('.gym-routine-name').waitFor();
    assert.deepEqual(await page.locator('.gym-routine-name').allTextContents(), ['Held routine A']);
    assert.deepEqual(await page.evaluate(() => [document.getElementById('auth-state').textContent, window.replica().state]), ['ghost', 'bound']);
    assert.equal(await page.locator('.gym-coach-door').count(), 0, 'no sign-in pitch stands in the room’s place');
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Sign in', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.issues ?? []), []);
  });
});

test('Chromium: a browser signed out draws the room on its own copy', async (t) => {
  const { page } = await boot(t, { seeded: false, me: 'nobody' });
  await withBrowserErrors(page, async () => {
    await page.locator('.gym-room').waitFor();
    await page.waitForFunction(() => document.getElementById('auth-state').textContent === 'ghost');
    assert.equal(await page.locator('.gym-coach-door').count(), 0, 'no sign-in pitch stands in the room’s place');
    assert.equal(await page.locator('.gym-tabs a').count(), 3);
    assert.deepEqual(await page.evaluate(() => [window.replica().state, window.issues ?? []]), ['anon', []]);
  });
});

test('Chromium: a re-identify keeps the room, and what is typed in it', async (t) => {
  const { page } = await boot(t, { seeded: true, me: 'held', hash: '#/gym/backfill/routineBootA' });
  await withBrowserErrors(page, async () => {
    await page.getByRole('button', { name: 'Yesterday', exact: true }).click();
    const before = await page.evaluate(() => { window.roomBefore = document.querySelector('.gym-room'); return window.replica().replica; });
    await page.evaluate(() => window.reidentify());
    await page.waitForFunction((replica) => window.replica().replica !== replica, before);
    await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => setTimeout(drawn, 0))));
    assert.deepEqual(await page.evaluate(() => ({ sameRoom: document.querySelector('.gym-room') === window.roomBefore,
      day: [...document.querySelectorAll('.gym-past-days .gym-chip.is-on')].map((chip) => chip.textContent), issues: window.issues ?? [] })),
    { sameRoom: true, day: ['Yesterday'], issues: [] });
  });
});

test('Chromium: a page restored from the back/forward cache keeps the room, a typed form and its scroll', async (t) => {
  const { page } = await boot(t, { seeded: true, me: 'A', hash: '#/gym/backfill/routineBootA' });
  await withBrowserErrors(page, async () => {
    await page.setViewportSize({ width: 1440, height: 320 });
    await page.getByRole('button', { name: 'Yesterday', exact: true }).click();
    await page.getByRole('button', { name: 'Change time', exact: true }).click();
    await page.getByLabel('Start time', { exact: true }).fill('07:15');
    const before = await page.evaluate(() => {
      const scroller = document.querySelector('.gym-scroll');
      scroller.scrollTop = 120;
      window.roomBefore = document.querySelector('.gym-room');
      return { scrollTop: scroller.scrollTop, start: document.querySelector('.gym-past-start').value };
    });
    assert.deepEqual(before, { scrollTop: 120, start: '07:15' }, 'the form scrolls and holds what was typed');
    const restored = await page.evaluate(async () => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      await new Promise((frame) => requestAnimationFrame(() => setTimeout(frame, 50)));
      const { syncSession } = await import('/src/platform/sync/session.js');
      const suspended = { closed: syncSession.engine.closed, sameRoom: document.querySelector('.gym-room') === window.roomBefore };
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      await syncSession.engine.restoring;
      await new Promise((frame) => requestAnimationFrame(() => setTimeout(frame, 50)));
      return { suspended, sameRoom: document.querySelector('.gym-room') === window.roomBefore, closed: syncSession.engine.closed,
        scrollTop: document.querySelector('.gym-scroll').scrollTop, start: document.querySelector('.gym-past-start')?.value ?? null,
        day: [...document.querySelectorAll('.gym-past-days .gym-chip.is-on')].map((chip) => chip.textContent), issues: window.issues ?? [] };
    });
    assert.deepEqual(restored, { suspended: { closed: true, sameRoom: true }, sameRoom: true, closed: false, scrollTop: 120, start: '07:15',
      day: ['Yesterday'], issues: [] });
  });
});

test('Chromium: another tab’s account is not drawn under this tab’s, which waits for the shell to catch up', async (t) => {
  const { context, page } = await boot(t, { seeded: true, me: 'A' });
  await withBrowserErrors(page, async () => {
    await page.waitForFunction(() => document.getElementById('auth-state').textContent === 'signed-in');
    await page.locator('.gym-routine-name').waitFor();
    assert.deepEqual(await page.locator('.gym-routine-name').allTextContents(), ['Held routine A']);
    const other = await context.newPage();
    await other.goto(`${origin}/gym-boot#/gym`);
    await other.waitForFunction(() => window.entryReady);
    await visit(other, 'B', { signOutFirst: true });
    // Well inside the shell's 20 s account poll, which would sign A back in.
    await page.locator('.gym-routine-name').waitFor({ state: 'detached', timeout: 5000 });
    assert.deepEqual(await page.evaluate(() => ({ seat: document.getElementById('auth-state').textContent,
      bound: window.replica().account, quiet: [...document.querySelectorAll('.gym-quiet')].map((line) => line.textContent),
      routines: document.querySelectorAll('.gym-routine-name').length })),
    { seat: 'signed-in', bound: 'B', quiet: ['Opening the log…'], routines: 0 });
  });
});
