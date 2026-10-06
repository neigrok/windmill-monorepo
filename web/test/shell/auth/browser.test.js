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
        import { CloseAccountSection } from '/src/shell/settings/CloseAccountSection.jsx';
        import { SessionsSection } from '/src/shell/settings/SessionsSection.jsx';
        import { syncSession } from '/src/platform/sync/session.js';
        import { BrowserSyncEngine } from '/src/platform/sync/engine.js';
        import { Registry } from '/src/platform/sync/core/registry.js';
        function AuthView() {
          const auth = useAuth(); window.auth = auth;
          return React.createElement('div', null, React.createElement('p', { id: 'auth-state' }, auth.status),
            auth.status === 'signed-in' && React.createElement(React.Fragment, null,
              React.createElement(SessionsSection), React.createElement(CloseAccountSection)));
        }
        window.mountAuth = async (name, upgrade = true) => {
          const probe = await (await fetch('/@fs${registryPath}')).json();
          window.syncFailures = [];
          const registry = new Registry(probe);
          window.engine = await BrowserSyncEngine.open({ name, registry, limits: { SIGNOUT_FLUSH_MS: 30 },
            transport: { request: async (endpoint) => ({ response: upgrade ? { status: 426, body: {} }
              : endpoint === 'hello' ? { status: 200, body: { serverTime: Date.now(), epoch: 'test', as: 'A',
                schema: registry.version, minSchema: registry.minVersion, holdsRecords: { probe: false } } }
              : { status: 503, body: {} }, timing: { send: engine.reading(), recv: engine.reading() } }),
              openLive() { throw new Error('offline'); } },
            telemetry: { failure(operation) { syncFailures.push(operation); }, event() {} } });
          await engine.start();
          syncSession.engine = engine;
          syncSession.opening = Promise.resolve(engine);
          syncSession.open = (options) => { engine.credentials = options.credentials; return syncSession.opening; };
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
    assert.equal(await page.getByText('Couldn’t finish updating your account on this device. Try again.').count(), 0);
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

async function settings(context, name) {
  const state = { signedIn: true, userId: 'A', sessionId: 'this', requests: [], closeStatus: 200 };
  await context.route('**/v1/me', async (route) => {
    const method = route.request().method();
    state.requests.push(`${method} /v1/me`);
    if (method === 'DELETE') {
      if (state.beforeClose) await state.beforeClose();
      if (state.closeStatus === 200) state.signedIn = false;
      if (state.closeResponseLost) return route.abort('failed');
      return route.fulfill({ status: state.closeStatus, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ status: state.signedIn ? 200 : 401, contentType: 'application/json',
      body: JSON.stringify({ user: { id: state.userId, name: 'Ada', email: 'ada@example.test' } }) });
  });
  await context.route('**/v1/sessions', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ sessions: state.sessionId ? [{ id: state.sessionId, current: true, userAgent: 'Firefox/120' }] : [] }) }));
  await context.route('**/v1/sessions/this', (route) => {
    state.requests.push('DELETE /v1/sessions/this');
    return route.fulfill({ status: 204 });
  });
  await context.route('**/v1/auth/logout', (route) => {
    state.requests.push('POST /v1/auth/logout'); state.signedIn = false;
    return route.fulfill({ status: 204 });
  });
  const page = await context.newPage();
  await page.goto(`${origin}/auth-test#/settings`);
  await page.waitForFunction(() => typeof mountAuth === 'function');
  await page.evaluate((name) => mountAuth(name, false), name);
  await page.getByRole('button', { name: 'Revoke Firefox' }).waitFor();
  await pending(page);
  return { page, state };
}

test('Chromium: revoking this session waits for Keep/Discard; Cancel and storage failure do not navigate', async () => {
  await ready;
  for (const choice of ['Keep', 'Discard']) {
    const context = await browser.newContext();
    try {
      const { page, state } = await settings(context, `auth-revoke-${choice}`);
      const replica = await page.evaluate(() => engine.device.activeReplica.id);
      await page.getByRole('button', { name: 'Revoke Firefox' }).click();
      const dialog = page.getByRole('dialog').filter({ hasText: 'Sign out?' });
      await dialog.waitFor();
      assert.equal(page.url(), `${origin}/auth-test#/settings`);
      assert.equal(await page.locator('#auth-state').textContent(), 'signed-in');
      assert.equal(state.signedIn, true);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.evaluate(() => auth.refresh());
      assert.equal(page.url(), `${origin}/auth-test#/settings`);
      assert.equal(state.signedIn, true);
      assert.deepEqual(state.requests.filter((request) => !request.startsWith('GET')), []);
      await page.getByRole('button', { name: 'Revoke Firefox' }).click();
      await dialog.waitFor();
      await page.evaluate(() => {
        const transact = engine.store.transact.bind(engine.store);
        engine.store.transact = (...args) => window.refuseStorage
          ? Promise.reject(new DOMException('storage refused', 'QuotaExceededError')) : transact(...args);
        window.refuseStorage = true;
      });
      await dialog.getByRole('button', { name: choice, exact: true }).click();
      await dialog.getByRole('alert').waitFor();
      assert.equal(page.url(), `${origin}/auth-test#/settings`);
      assert.equal(state.signedIn, true);
      assert.equal(await page.evaluate(() => engine.device.activeReplica.id), replica);
      await page.evaluate(() => { window.refuseStorage = false; });
      await dialog.getByRole('button', { name: choice, exact: true }).click();
      await page.waitForURL(`${origin}/auth-test#/`);
      assert.equal(await page.locator('#auth-state').textContent(), 'ghost');
      assert.equal(state.signedIn, false);
      assert.deepEqual(state.requests.filter((request) => !request.startsWith('GET')), ['POST /v1/auth/logout']);
      assert.deepEqual(await page.evaluate((replica) => {
        const retained = engine.device.replicas.find((each) => each.id === replica);
        return retained ? { state: retained.meta.state, entries: retained.outbox.length } : null;
      }, replica), choice === 'Keep' ? { state: 'dormant', entries: 1 } : null);
    } finally { await context.close(); }
  }
});

test('Chromium: account closure discards without asking; failed server and local cleanup remain retryable', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const { page, state } = await settings(context, 'auth-close-account');
    const replica = await page.evaluate(() => engine.device.activeReplica.id);
    await page.getByRole('button', { name: 'Close my account', exact: true }).click();
    await page.getByPlaceholder('ada@example.test').fill('ada@example.test');
    state.sessionId = null;
    await page.getByRole('button', { name: 'Close my account', exact: true }).click();
    await page.getByText('Couldn’t finish closing your account on this device. Try again.').waitFor();
    assert.deepEqual(state.requests.filter((request) => request.startsWith('DELETE')), []);
    assert.equal(await page.evaluate(() => engine.device.activeReplica.id), replica);
    state.sessionId = 'this';
    await page.evaluate(() => {
      window.failMarker = true;
      const transact = engine.store.transact.bind(engine.store);
      engine.store.transact = (change, options) => {
        if (window.storageBlocked) return Promise.reject(new DOMException('storage refused', 'QuotaExceededError'));
        return transact((device) => {
          const answer = change(device);
          if (window.failMarker && device.meta.closingAccount) {
            window.storageBlocked = true;
            throw new DOMException('storage refused', 'QuotaExceededError');
          }
          return answer;
        }, options);
      };
    });
    await page.getByRole('button', { name: 'Close my account', exact: true }).click();
    await page.getByText('Couldn’t finish closing your account on this device. Try again.').waitFor();
    assert.equal(page.url(), `${origin}/auth-test#/settings`);
    assert.deepEqual(state.requests.filter((request) => request.startsWith('DELETE')), []);
    assert.equal(await page.evaluate(() => !!engine.releaseSignOut), true);
    await page.evaluate(() => { window.failMarker = false; window.storageBlocked = false; });
    state.closeStatus = 503;
    await page.getByRole('button', { name: 'Close my account', exact: true }).click();
    await page.getByText('Couldn’t finish closing your account on this device. Try again.').waitFor();
    assert.equal(page.url(), `${origin}/auth-test#/settings`);
    assert.equal(state.signedIn, true);
    assert.equal(await page.evaluate(() => engine.device.activeReplica.id), replica);
    assert.equal(await page.evaluate(() => engine.signingOut), false);
    state.closeStatus = 200;
    state.beforeClose = () => page.evaluate(async () => {
      await engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'card0002', f: { title: 'late work' } }]);
      const transact = engine.store.transact.bind(engine.store);
      engine.store.transact = (...args) => window.refuseStorage
        ? Promise.reject(new DOMException('storage refused', 'QuotaExceededError')) : transact(...args);
      window.refuseStorage = true;
    });
    await page.getByRole('button', { name: 'Close my account', exact: true }).click();
    await page.getByText('Couldn’t finish closing your account on this device. Try again.').waitFor();
    assert.equal(state.signedIn, false);
    assert.equal(page.url(), `${origin}/auth-test#/settings`);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.evaluate(() => engine.device.activeReplica.id), replica);
    assert.equal(await page.evaluate(() => engine.device.activeReplica.outbox.length), 2);
    await page.evaluate(() => auth.refresh().catch(() => {}));
    assert.deepEqual(state.requests.filter((request) => request.startsWith('DELETE')), ['DELETE /v1/me', 'DELETE /v1/me']);
    await page.evaluate(() => { window.refuseStorage = false; });
    await page.getByRole('button', { name: 'Close my account', exact: true }).click();
    await page.waitForURL(`${origin}/auth-test#/`);
    assert.equal(await page.locator('#auth-state').textContent(), 'ghost');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.evaluate((replica) => engine.device.replicas.some((each) => each.id === replica), replica), false);
    assert.deepEqual(state.requests.filter((request) => request.startsWith('DELETE')), ['DELETE /v1/me', 'DELETE /v1/me']);
  } finally { await context.close(); }
});

test('Chromium: closure survives reload after failed local discard or a lost response without closing a successor account', async () => {
  await ready;
  for (const failure of ['storage', 'lost-response-B', 'lost-response-A']) {
    const context = await browser.newContext();
    try {
      const name = `auth-close-reload-${failure}`;
      const { page, state } = await settings(context, name);
      const replica = await page.evaluate(() => engine.device.activeReplica.id);
      if (failure === 'storage') state.beforeClose = () => page.evaluate(() => {
        engine.store.transact = () => Promise.reject(new DOMException('storage refused', 'QuotaExceededError'));
      });
      else state.closeResponseLost = true;
      await page.getByRole('button', { name: 'Close my account', exact: true }).click();
      await page.getByPlaceholder('ada@example.test').fill('ada@example.test');
      await page.getByRole('button', { name: 'Close my account', exact: true }).click();
      await page.getByText('Couldn’t finish closing your account on this device. Try again.').waitFor();
      assert.equal(state.signedIn, false);
      assert.deepEqual(await page.evaluate(() => engine.device.meta.closingAccount), { account: 'A', sessionId: 'this' });
      assert.equal(await page.evaluate(() => engine.device.activeReplica.id), replica);
      if (failure !== 'storage') { state.userId = failure.endsWith('A') ? 'A' : 'B'; state.sessionId = 'fresh'; state.signedIn = true; }
      await page.reload();
      await page.waitForFunction(() => typeof mountAuth === 'function');
      await page.evaluate((name) => mountAuth(name, false), name);
      await page.waitForFunction(() => document.getElementById('auth-state').textContent === 'ghost');
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await page.evaluate((replica) => engine.device.replicas.some((each) => each.id === replica), replica), false);
      assert.equal(await page.evaluate(() => engine.device.meta.closingAccount), undefined);
      assert.deepEqual(state.requests.filter((request) => request.startsWith('DELETE')), ['DELETE /v1/me']);
      assert.equal(state.signedIn, failure !== 'storage');
    } finally { await context.close(); }
  }
});

test('Chromium: a freshly verified session undoes account closure while discarding the old local replica', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const { page, state } = await settings(context, 'auth-close-undo');
    const replica = await page.evaluate(() => engine.device.activeReplica.id);
    state.beforeClose = () => page.evaluate(() => {
      window.refuseStorage = true;
      const transact = engine.store.transact.bind(engine.store);
      engine.store.transact = (...args) => window.refuseStorage
        ? Promise.reject(new DOMException('storage refused', 'QuotaExceededError')) : transact(...args);
    });
    await page.getByRole('button', { name: 'Close my account', exact: true }).click();
    await page.getByPlaceholder('ada@example.test').fill('ada@example.test');
    await page.getByRole('button', { name: 'Close my account', exact: true }).click();
    await page.getByText('Couldn’t finish closing your account on this device. Try again.').waitFor();
    state.signedIn = true; state.sessionId = 'fresh';
    await page.evaluate(async () => {
      window.refuseStorage = false;
      await auth.signIn({ id: 'A', name: 'Ada', email: 'ada@example.test' });
    });
    assert.equal(await page.locator('#auth-state').textContent(), 'signed-in');
    assert.equal(state.signedIn, true);
    assert.deepEqual(state.requests.filter((request) => !request.startsWith('GET')), ['DELETE /v1/me']);
    assert.equal(await page.evaluate((replica) => engine.device.replicas.some((each) => each.id === replica), replica), false);
    assert.deepEqual(await page.evaluate(() => ({ account: engine.device.activeReplica.meta.account,
      entries: engine.device.activeReplica.outbox.length, closing: engine.device.meta.closingAccount,
      clearCredential: engine.device.meta.clearCredential })), { account: 'A', entries: 0, closing: undefined, clearCredential: undefined });
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
