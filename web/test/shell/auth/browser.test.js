import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

let server, browser, origin;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const registryPath = fileURLToPath(new URL('../../../../packages/api-contract/sync/probe.registry.json', import.meta.url));
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-auth-test`, plugins: [{
    name: 'auth-upgrade-fixture',
    configureServer(server) {
      server.middlewares.use('/auth-test', (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><title>Account update test</title><div id="root"></div><script type="module" src="/auth-test-fixture.js"></script>');
      });
    },
    resolveId(id) { if (id === '/auth-test-fixture.js') return id; },
    load(id) {
      if (id === '/auth-test-fixture.js') return `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import AuthProvider, { useAuth } from '/src/shell/auth/AuthProvider.jsx';
        import { syncSession } from '/src/platform/sync/session.js';
        import { BrowserSyncEngine } from '/src/platform/sync/engine.js';
        import { Registry } from '/src/platform/sync/core/registry.js';
        function AuthView() { const auth = useAuth(); return React.createElement('p', { id: 'auth-state' }, auth.status); }
        window.mountAuth = async (name) => {
          const probe = await (await fetch('/@fs${registryPath}')).json();
          window.syncFailures = [];
          window.engine = await BrowserSyncEngine.open({ name, registry: new Registry(probe),
            transport: { request: async () => ({ response: { status: 426, body: {} } }), openLive() { throw new Error('offline'); } },
            telemetry: { failure(operation) { syncFailures.push(operation); }, event() {} } });
          await engine.start();
          syncSession.engine = engine;
          syncSession.opening = Promise.resolve(engine);
          syncSession.publish({ engine, ready: true });
          window.app = createRoot(document.getElementById('root'));
          app.render(React.createElement(AuthProvider, null, React.createElement(AuthView)));
        };
      `;
    },
  }], optimizeDeps: { include: ['react', 'react-dom/client', '@noble/hashes/sha256', '@noble/hashes/utils'] },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => { await ready; await browser?.close(); await server?.close(); });

async function open(context, name) {
  await context.route('**/v1/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: 'A', name: 'Ada' } }) }));
  const page = await context.newPage();
  await page.goto(`${origin}/auth-test`);
  await page.waitForFunction(() => typeof mountAuth === 'function');
  await page.evaluate((name) => mountAuth(name), name);
  await page.getByRole('alert').filter({ hasText: 'Update required.' }).waitFor();
  return page;
}

async function pending(page) {
  return page.evaluate(async () => {
    await engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'card0001', f: { title: 'private' } }]);
    return { gestureId: engine.device.activeReplica.outbox[0].gestureId, device: (await engine.store.read()).device.toJSON() };
  });
}

test('Chromium: a 426 shows the update state; a verified latest-shell reload retains pending local work', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const page = await open(context, 'auth-upgrade-reload');
    assert.equal(await page.getByText('Couldn’t connect your account. Your work is still on this device.').count(), 0);
    const before = await pending(page);
    await page.evaluate(() => {
      window.shellRequests = [];
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
        controller: { postMessage(message, ports) { shellRequests.push(message); window.replyToShell = ports[0]; } },
      } });
    });
    await page.getByRole('button', { name: 'Reload latest version' }).click();
    await page.getByRole('button', { name: 'Fetching update…' }).waitFor();
    assert.equal(page.url(), `${origin}/auth-test`);
    assert.deepEqual(await page.evaluate(() => shellRequests), [{ type: 'refresh-shell' }]);
    assert.deepEqual(await page.evaluate(async () => (await engine.store.read()).device.toJSON()), before.device);
    const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    await page.evaluate(() => replyToShell.postMessage({ ok: true }));
    await navigation;
    await page.waitForFunction(() => typeof mountAuth === 'function');
    await page.evaluate(() => mountAuth('auth-upgrade-reload'));
    await page.getByRole('alert').filter({ hasText: 'Update required.' }).waitFor();
    const retained = await page.evaluate(async () => (await engine.store.read()).device.toJSON());
    assert.ok(retained.meta.authGeneration >= before.device.meta.authGeneration);
    assert.deepEqual(retained, { ...before.device, meta: { ...before.device.meta, authGeneration: retained.meta.authGeneration } });
    assert.equal(await page.evaluate(() => engine.device.activeReplica.outbox[0].gestureId), before.gestureId);
  } finally { await context.close(); }
});

test('Chromium: refused, stalled and broken shell updates keep the room and durable work available for retry', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const page = await open(context, 'auth-upgrade-retry');
    const before = await pending(page);
    await page.evaluate(() => {
      const originalTimeout = window.setTimeout;
      window.setTimeout = (run, ms, ...args) => originalTimeout(run, ms === 30000 ? 40 : ms, ...args);
      window.updateMode = 'refused';
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
        controller: { postMessage(_message, ports) {
          if (updateMode === 'refused') ports[0].postMessage({ ok: false });
          if (updateMode === 'broken') throw new Error('worker unavailable');
        } },
      } });
    });
    for (const mode of ['refused', 'stalled', 'broken']) {
      await page.evaluate((mode) => { updateMode = mode; }, mode);
      await page.getByRole('button', { name: 'Reload latest version' }).click();
      await page.getByText('Couldn’t fetch the update. Your work is still here. Try again when connected.').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Reload latest version' }).isEnabled(), true);
      assert.equal(page.url(), `${origin}/auth-test`);
      assert.deepEqual(await page.evaluate(async () => (await engine.store.read()).device.toJSON()), before.device);
    }
    await context.route(`${origin}/`, (route) => route.fulfill({ status: 503, body: 'unavailable' }));
    await page.evaluate(() => { Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined }); });
    await page.getByRole('button', { name: 'Reload latest version' }).click();
    await page.getByText('Couldn’t fetch the update. Your work is still here. Try again when connected.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Reload latest version' }).isEnabled(), true);
    assert.equal(page.url(), `${origin}/auth-test`);
    assert.deepEqual(await page.evaluate(async () => (await engine.store.read()).device.toJSON()), before.device);
  } finally { await context.close(); }
});

test('Chromium: a persisted restore refreshes the account; focus and delayed auth replies never write to the suspended store', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const page = await open(context, 'auth-persisted-restore');
    const before = await pending(page);
    let refreshes = 0;
    let delayedRoute;
    await context.route('**/v1/me', (route) => {
      refreshes++;
      if (refreshes === 1) { delayedRoute = route; return; }
      return route.fulfill({ status: 401, body: '{}' });
    });
    const request = page.waitForRequest('**/v1/me');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await request;
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new Event('focus'));
    });
    await page.waitForFunction(() => engine.closed);
    await delayedRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: 'A', name: 'Ada' } }) });
    await page.evaluate(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    assert.equal(refreshes, 1);
    assert.deepEqual(await page.evaluate(() => syncFailures), []);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.waitForFunction(() => !engine.closed && document.getElementById('auth-state').textContent === 'ghost');
    assert.equal(refreshes, 2);
    const retained = await page.evaluate(async () => (await engine.store.read()).device.toJSON());
    assert.deepEqual(retained, { ...before.device, meta: { ...before.device.meta, authGeneration: retained.meta.authGeneration } });
  } finally { await context.close(); }
});
