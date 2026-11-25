import { SYNC_STATUS, ANONYMOUS_OWNER, LAPSED_SESSION } from '../../../src/products/roadmap/copy.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { beacon, withBrowserErrors } from '../../products/roadmap/browserFixture.js';

let server, browser, origin;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-auth-test`, plugins: [{
    name: 'auth-upgrade-fixture', enforce: 'pre',
    configureServer(server) {
      server.middlewares.use('/auth-test', (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><title>Account update test</title><div id="root"></div><script type="module" src="/auth-test-fixture.js"></script>');
      });
    },
    resolveId(id) {
      if (id === '/auth-test-fixture.js') return id;
      if (id.endsWith('/telemetry/beacon.js')) return '\0auth-events';
    },
    load(id) {
      if (id === '\0auth-events') return beacon;
      if (id === '/auth-test-fixture.js') return `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import AuthProvider, { useAuth } from '/src/shell/auth/AuthProvider.jsx';
        import { verifyToken } from '/src/shell/auth/AuthClient.js';
        import { CloseAccountSection } from '/src/shell/settings/CloseAccountSection.jsx';
        import { SessionsSection } from '/src/shell/settings/SessionsSection.jsx';
        import { syncSession } from '/src/platform/sync/session.js';
        import { BrowserSyncEngine } from '/src/platform/sync/engine.js';
        // The engine opens on the registry the shell ships, so each product's part in an account change finds its device rows.
        import { registry } from '/src/platform/sync/schema.js';
        import { registerRoomStatus, useRoomStatus } from '/src/shell/roomStatus.js';
        import { Shell } from '/src/shell/chrome/Shell.jsx';
        import { SignInDoorProvider } from '/src/shell/auth/SignInDoor.jsx';
        import { SyncSession as RoadmapSyncSession } from '/src/products/roadmap/sync/SyncSession.js';
        import { useRoomSyncNotices } from '/src/products/roadmap/sync/useRoomSyncNotices.js';
        import '/src/styles/global.css';
        const nothing = () => {};
        window.verifyToken = verifyToken;
        function LiveRoom() {
          const { status, lapsed } = useAuth();
          const [session, setSession] = React.useState(null);
          React.useEffect(() => {
            const current = new RoadmapSyncSession({ treeId: 't_offline_transition' });
            current.connect = function () { this.phase = 'live'; this.emitStatus(); return this; };
            current.start().then(() => setSession(current));
            return () => current.close();
          }, []);
          const { syncSnapshot } = useRoomSyncNotices({ treeId: 't_offline_transition', syncSession: session,
            owner: true, status, lapsed, phone: false, openSignInDoor: nothing, setBoardQuiet: nothing });
          return React.createElement('output', { id: 'live-room', 'data-phase': syncSnapshot?.phase,
            'data-online': String(syncSnapshot?.online) }, status);
        }
        function RoomPublication() {
          React.useLayoutEffect(() => {
            const room = registerRoomStatus();
            room.publish({ line: 'Room offline', connectivity: 'offline' });
            return () => room.release();
          }, []);
          return React.createElement('p', { id: 'room-state' }, 'Room offline');
        }
        function AuthView({ room }) {
          const auth = useAuth(); window.auth = auth;
          const publication = useRoomStatus();
          return React.createElement('div', null, room === true && React.createElement(RoomPublication),
            room === 'live' && React.createElement(SignInDoorProvider, null, React.createElement(Shell, {
              location: { pathname: '/app', hash: '', search: '' }, neutral: { Component: LiveRoom },
            })), React.createElement('p', { id: 'auth-state' }, auth.status),
            React.createElement('p', { id: 'room-publication' }, JSON.stringify(publication)),
            auth.status === 'signed-in' && React.createElement(React.Fragment, null,
              React.createElement(SessionsSection), React.createElement(CloseAccountSection)));
        }
        window.mountAuth = async (name, upgrade = true, room = false) => {
          window.syncFailures = [];
          const holdsRecords = Object.fromEntries(Object.keys(registry.products).map((product) => [product, false]));
          const options = { name, registry, limits: { SIGNOUT_FLUSH_MS: 30 },
            transport: { request: async (endpoint) => ({ response: upgrade ? { status: 426, body: {} }
              : endpoint === 'hello' ? { status: 200, body: { serverTime: Date.now(), epoch: 'test', as: 'A',
                schema: registry.version, minSchema: registry.minVersion, holdsRecords } }
              : { status: 503, body: {} }, timing: { send: (window.engine ?? syncSession.engine).reading(), recv: (window.engine ?? syncSession.engine).reading() } }),
              openLive() { throw new Error('offline'); } },
            telemetry: { failure(operation) { syncFailures.push(operation); }, event() {} } };
          if (room === 'live') window.engine = await syncSession.open(options);
          else {
            window.engine = await BrowserSyncEngine.open(options);
            await engine.start();
          }
          syncSession.engine = engine;
          syncSession.opening = Promise.resolve(engine);
          syncSession.open = (options) => { engine.credentials = options.credentials; return syncSession.opening; };
          syncSession.publish({ engine, ready: true, online: room !== true });
          window.app = createRoot(document.getElementById('root'));
          app.render(React.createElement(AuthProvider, null, React.createElement(AuthView, { room })));
        };
      `;
    },
  }], optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => { await ready; await browser?.close(); await server?.close(); });

async function open(context, name) {
  await context.route('**/v1/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: 'A', name: 'Ada' } }) }));
  const page = await context.newPage();
  await withBrowserErrors(page, async () => {
    await page.goto(`${origin}/auth-test`);
    await page.waitForFunction(() => typeof mountAuth === 'function');
    await page.evaluate((name) => mountAuth(name), name);
    await page.getByRole('alert').filter({ hasText: 'Update required.' }).waitFor();
  });
  return page;
}

async function pending(page) {
  return page.evaluate(async () => {
    await engine.commit('self/gym', [{ op: 'create', t: 'thread', id: 'thread0001', f: { title: 'private' } }]);
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
  const state = { signedIn: true, userId: 'A', sessionId: 'this', requests: [], closures: [], closeStatus: 200 };
  await context.route('**/v1/me', async (route) => {
    const method = route.request().method();
    state.requests.push(`${method} /v1/me`);
    if (method === 'DELETE') {
      state.closures.push(route.request().postDataJSON());
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

// Two tabs of one browser signed in on session s1, which another device revokes. The context's routes play the server and
// the browser's one cookie jar the tabs share: a request carries the cookie the jar holds as it arrives, a verify sets s2,
// a logout ends the session its cookie names and empties the jar. Tab A's read of the account is held where `moment` says,
// its answer taken as it arrived, while tab B completes a magic-link sign-in.
for (const moment of ['before the clear reads again', 'while the clear holds the cookie']) {
  test(`Chromium: a tab clears the cookie of a revoked session once, and a sign-in another tab completes ${moment} stays signed in`, async () => {
    await ready;
    const context = await browser.newContext();
    try {
      const server = { cookie: 's1', sessions: new Set(['s1']), reads: [], logouts: [], hold: null };
      const pages = new Map();
      await context.route('**/v1/me', async (route) => {
        const { cookie } = server;
        const user = server.sessions.has(cookie) ? { id: 'A', name: 'Ada', email: 'ada@example.test' } : null;
        const tab = pages.get(route.request().frame().page());
        server.reads.push({ tab, cookie });
        if (server.hold?.tab === tab && server.reads.filter((read) => read.tab === tab).length === server.hold.read) {
          server.hold.reached();
          await server.hold.released;
        }
        return route.fulfill({ status: user ? 200 : 401, contentType: 'application/json', body: JSON.stringify(user ? { user } : {}) });
      });
      await context.route('**/v1/auth/verify', (route) => {
        server.cookie = 's2'; server.sessions.add('s2'); server.verified?.();
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ user: { id: 'A', name: 'Ada', email: 'ada@example.test' } }) });
      });
      await context.route('**/v1/sessions', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"sessions":[]}' }));
      await context.route('**/v1/auth/logout', (route) => {
        server.logouts.push({ tab: pages.get(route.request().frame().page()), cookie: server.cookie });
        server.sessions.delete(server.cookie); server.cookie = null;
        return route.fulfill({ status: 204 });
      });
      const errors = [];
      const open = async (tab) => {
        const page = await context.newPage();
        pages.set(page, tab);
        page.on('pageerror', (error) => errors.push(`${tab}: ${error.message}`));
        await page.goto(`${origin}/auth-test`);
        await page.waitForFunction(() => typeof mountAuth === 'function');
        await page.evaluate(() => mountAuth('auth-lapsed-cookie', false));
        await page.waitForFunction(() => document.getElementById('auth-state')?.textContent === 'signed-in');
        return page;
      };
      const a = await open('A');
      const b = await open('B');
      server.sessions.delete('s1');
      const reached = new Promise((resolve) => {
        server.hold = { tab: 'A', read: server.reads.filter((read) => read.tab === 'A').length + (moment.startsWith('before') ? 1 : 2), reached: resolve };
      });
      let release;
      server.hold.released = new Promise((resolve) => { release = resolve; });
      await a.evaluate(() => { window.refreshing = auth.refresh(); });
      await reached;
      const signIn = () => b.evaluate(() => { window.signingIn = verifyToken('link').then(({ user }) => auth.signIn(user)); });
      if (moment.startsWith('before')) {
        await signIn();
        await b.evaluate(() => window.signingIn);
      } else {
        // B's verify either waits for the cookie, or reaches the server first and sets s2 before A's held read answers.
        const verified = new Promise((resolve) => { server.verified = resolve; });
        await signIn();
        const waiting = b.waitForFunction(() => {
          navigator.locks.query().then(({ pending }) => { window.waitsForCookie = pending.some((lock) => lock.name === 'windmill:auth-cookie'); });
          return window.waitsForCookie === true;
        });
        waiting.catch(() => {});
        await Promise.race([verified, waiting]);
      }
      release();
      await a.evaluate(() => window.refreshing);
      await b.evaluate(() => window.signingIn);
      await a.evaluate(async () => { await auth.refresh(); await new Promise(requestAnimationFrame); });
      assert.deepEqual({
        cookie: server.cookie, live: [...server.sessions], logouts: server.logouts, errors,
        a: await a.locator('#auth-state').textContent(), b: await b.locator('#auth-state').textContent(),
        told: { a: await a.evaluate(() => (window.events ?? []).filter((event) => event.name === 'auth_session_cleared')),
          b: await b.evaluate(() => (window.events ?? []).filter((event) => event.name === 'auth_session_cleared')) },
      }, {
        cookie: 's2', live: ['s2'], errors: [], a: 'signed-in', b: 'signed-in',
        logouts: moment.startsWith('before') ? [] : [{ tab: 'A', cookie: 's1' }],
        told: { a: [{ name: 'auth_session_cleared', props: { outcome: moment.startsWith('before') ? 'kept' : 'cleared' } }], b: [] },
      });
    } finally { await context.close(); }
  });
}

// The same played server and shared cookie jar: a lapse is cleared once, whichever tab or page reads it next, until a
// sign-in brings a cookie back.
test('Chromium: a lapsed session\'s cookie is cleared once a lapse: one logout and one event across a reload and a second tab, and one again after a sign-in lapses', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const server = { cookie: 's1', sessions: new Set(['s1']), logouts: [] };
    const pages = new Map();
    await context.route('**/v1/me', (route) => {
      const user = server.sessions.has(server.cookie) ? { id: 'A', name: 'Ada', email: 'ada@example.test' } : null;
      return route.fulfill({ status: user ? 200 : 401, contentType: 'application/json', body: JSON.stringify(user ? { user } : {}) });
    });
    await context.route('**/v1/auth/verify', (route) => {
      server.cookie = 's2'; server.sessions.add('s2');
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ user: { id: 'A', name: 'Ada', email: 'ada@example.test' } }) });
    });
    await context.route('**/v1/sessions', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"sessions":[]}' }));
    await context.route('**/v1/auth/logout', (route) => {
      server.logouts.push({ tab: pages.get(route.request().frame().page()), cookie: server.cookie });
      server.sessions.delete(server.cookie); server.cookie = null;
      return route.fulfill({ status: 204 });
    });
    const errors = [];
    const mount = async (page, state) => {
      await page.waitForFunction(() => typeof mountAuth === 'function');
      await page.evaluate(() => mountAuth('auth-lapse-once', false));
      await page.waitForFunction((wanted) => document.getElementById('auth-state')?.textContent === wanted, state);
      await page.evaluate(() => auth.refresh());
    };
    const open = async (tab, state) => {
      const page = await context.newPage();
      pages.set(page, tab);
      page.on('pageerror', (error) => errors.push(`${tab}: ${error.message}`));
      await page.goto(`${origin}/auth-test`);
      await mount(page, state);
      return page;
    };
    const told = (page) => page.evaluate(() => (window.events ?? []).filter((event) => event.name === 'auth_session_cleared')
      .map((event) => event.props.outcome));
    const a = await open('A', 'signed-in');
    server.sessions.delete('s1');
    await a.evaluate(() => auth.refresh());
    const lapse = await told(a);
    await a.reload();
    await mount(a, 'ghost');
    const reloaded = await told(a);
    const b = await open('B', 'ghost');
    const opened = await told(b);
    const cleared = [...server.logouts];
    await b.evaluate(async () => { const { user } = await verifyToken('link'); await auth.signIn(user); });
    await a.waitForFunction(() => document.getElementById('auth-state')?.textContent === 'signed-in');
    server.sessions.delete('s2');
    await b.evaluate(() => auth.refresh());
    await a.evaluate(() => auth.refresh());
    assert.deepEqual({ cleared, told: { lapse, reloaded, opened, again: await told(b), aAgain: await told(a) },
      logouts: server.logouts, cookie: server.cookie, errors }, {
      cleared: [{ tab: 'A', cookie: 's1' }],
      told: { lapse: ['cleared'], reloaded: [], opened: [], again: ['cleared'], aAgain: [] },
      logouts: [{ tab: 'A', cookie: 's1' }, { tab: 'B', cookie: 's2' }], cookie: null, errors: [],
    });
  } finally { await context.close(); }
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
      await engine.commit('self/gym', [{ op: 'create', t: 'thread', id: 'thread0002', f: { title: 'late work' } }]);
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

test('Chromium: closure names the confirmed account and a mismatch keeps its pending work', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const { page, state } = await settings(context, 'auth-close-mismatch');
    await page.waitForFunction(() => engine.device.activeReplica.meta.pushRetryAt);
    const replica = await page.evaluate(() => engine.device.activeReplica.toJSON());
    state.closeStatus = 409;
    await page.getByRole('button', { name: 'Close my account', exact: true }).click();
    await page.getByPlaceholder('ada@example.test').fill('ada@example.test');
    await page.getByRole('button', { name: 'Close my account', exact: true }).click();
    await page.getByText('Couldn’t finish closing your account on this device. Try again.').waitFor();
    assert.deepEqual(state.closures, [{ account: 'A' }]);
    assert.equal(state.signedIn, true);
    assert.equal(page.url(), `${origin}/auth-test#/settings`);
    const retained = await page.evaluate(() => engine.device.activeReplica.toJSON());
    // A fresh hello samples the clock; the bounded flush can schedule another send.
    delete replica.meta.pushRetryAt; delete retained.meta.pushRetryAt;
    delete replica.meta.clockReading; delete retained.meta.clockReading;
    assert.ok(retained.meta.offsetSamples.every(({ offset, rtt }) => Number.isFinite(offset) && Number.isFinite(rtt)));
    assert.ok(Number.isFinite(retained.meta.serverOffsetMs));
    delete replica.meta.offsetSamples; delete retained.meta.offsetSamples;
    delete replica.meta.serverOffsetMs; delete retained.meta.serverOffsetMs;
    assert.deepEqual(retained, replica);
    assert.equal(await page.evaluate(() => engine.device.meta.closingAccount), undefined);
    assert.equal(await page.evaluate(() => engine.signingOut), false);
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


test('Chromium: the global offline notice yields only while a room publishes offline connectivity', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const page = await open(context, 'auth-room-connectivity');
    await withBrowserErrors(page, async () => {
      const notice = page.getByText('Offline. Coach, echoes, nudges, voice and export need a connection.', { exact: true });
      await page.evaluate(async () => {
        const { syncSession } = await import('/src/platform/sync/session.js');
        syncSession.publish({ online: false });
      });
      await notice.waitFor();
      await page.evaluate(async () => {
        const { registerRoomStatus } = await import('/src/shell/roomStatus.js');
        window.firstRoom = registerRoomStatus();
      });
      await page.waitForFunction(() => document.getElementById('room-publication')?.textContent === JSON.stringify({ status: null }));
      await notice.waitFor();
      for (const status of [
        { line: ANONYMOUS_OWNER },
        { line: LAPSED_SESSION },
        { line: SYNC_STATUS.saving, narrow: 'announce' },
        { line: 'Offline without a connectivity claim' },
      ]) {
        await page.evaluate((status) => firstRoom.publish(status), status);
        await page.waitForFunction((status) => document.getElementById('room-publication')?.textContent === JSON.stringify({ status }), status);
        await notice.waitFor();
        assert.equal(await notice.count(), 1);
      }
      await page.evaluate(() => firstRoom.publish({ line: 'Room offline', connectivity: 'offline' }));
      await notice.waitFor({ state: 'detached' });
      await page.evaluate(async () => {
        const { registerRoomStatus } = await import('/src/shell/roomStatus.js');
        window.secondRoom = registerRoomStatus();
        secondRoom.publish({ line: 'Another room offline', connectivity: 'offline' });
        firstRoom.release();
      });
      await page.waitForFunction(() => document.getElementById('room-publication')?.textContent === JSON.stringify({
        status: { line: 'Another room offline', connectivity: 'offline' },
      }));
      assert.equal(await notice.count(), 0);
      await page.evaluate(() => secondRoom.publish(null));
      await notice.waitFor();
      assert.equal(await notice.count(), 1);
      await page.evaluate(() => secondRoom.publish({ line: 'Room offline', connectivity: 'offline' }));
      await notice.waitFor({ state: 'detached' });
      await page.evaluate(() => secondRoom.release());
      await notice.waitFor();
      await page.evaluate(async () => {
        const { syncSession } = await import('/src/platform/sync/session.js');
        syncSession.publish({ online: true });
        secondRoom.release();
      });
      await notice.waitFor({ state: 'detached' });
    });
  } finally {
    await context.close();
  }
});


test('Chromium: an offline room owns the notice before its first painted frame', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    await context.route('**/v1/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":null}' }));
    const page = await context.newPage();
    await withBrowserErrors(page, async () => {
      await page.goto(`${origin}/auth-test`);
      await page.waitForFunction(() => typeof mountAuth === 'function');
      await page.evaluate(async () => {
        window.paintedNotices = [];
        const inspect = () => {
          if (document.getElementById('room-state')) {
            paintedNotices.push([...document.querySelectorAll('[role="status"]')].map((element) => element.textContent));
          }
          if (paintedNotices.length < 3) requestAnimationFrame(inspect);
        };
        requestAnimationFrame(inspect);
        await mountAuth('auth-room-first-paint', false, true);
      });
      await page.waitForFunction(() => paintedNotices.length === 3);
      assert.deepEqual(await page.evaluate(() => paintedNotices), [[], [], []]);
      assert.equal(await page.locator('#room-state').textContent(), 'Room offline');
    });
  } finally { await context.close(); }
});

test('Chromium: an anonymous owner keeps the global offline signal beside the device-only line', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    await context.route('**/v1/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":null}' }));
    const page = await context.newPage();
    await withBrowserErrors(page, async () => {
      await page.goto(`${origin}/auth-test`);
      await page.waitForFunction(() => typeof mountAuth === 'function');
      await page.evaluate(() => mountAuth('auth-anonymous-offline', false));
      await page.waitForFunction(() => document.getElementById('auth-state')?.textContent === 'ghost');
      await page.evaluate(async (line) => {
        const { syncSession } = await import('/src/platform/sync/session.js');
        const { registerRoomStatus } = await import('/src/shell/roomStatus.js');
        window.anonymousRoom = registerRoomStatus();
        anonymousRoom.publish({ line, narrow: 'device' });
        syncSession.publish({ online: false });
      }, ANONYMOUS_OWNER);
      const notice = page.getByText('Offline. Coach, echoes, nudges, voice and export need a connection.', { exact: true });
      await notice.waitFor();
      assert.deepEqual(await page.evaluate(() => ({ user: auth.user, status: auth.status, lapsed: auth.lapsed })),
        { user: null, status: 'ghost', lapsed: false });
      assert.equal(await notice.count(), 1);
    });
  } finally { await context.close(); }
});


test('Chromium: a live signed-in room going offline never inserts or paints the global notice', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    await context.route('**/v1/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = path === '/v1/me' ? { user: { id: 'A', name: 'Ada', email: 'ada@example.test' } }
        : path === '/v1/sessions' ? { sessions: [] } : {};
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    await withBrowserErrors(page, async () => {
      await page.goto(`${origin}/auth-test`);
      await page.waitForFunction(() => typeof mountAuth === 'function');
      await page.evaluate(() => mountAuth('auth-live-offline-transition', false, 'live'));
      await page.locator('#live-room[data-phase="live"][data-online="true"]').waitFor();
      await page.waitForFunction(() => document.getElementById('live-room')?.textContent === 'signed-in');
      await page.locator('.wm-room-status').waitFor({ state: 'attached' });
      await page.getByText('No other sessions.', { exact: true }).waitFor();
      await page.evaluate(() => {
        window.committedNotices = [];
        window.paintedNotices = [];
        const record = (node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const statuses = [...node.querySelectorAll('[role="status"]')];
          if (node.matches('[role="status"]')) statuses.unshift(node);
          for (const status of statuses) if (status.textContent) committedNotices.push(status.textContent);
        };
        window.noticeObserver = new MutationObserver((records) => {
          for (const mutation of records) {
            for (const node of mutation.addedNodes) record(node);
            const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
            const status = target?.closest('[role="status"]');
            if (status?.textContent) committedNotices.push(status.textContent);
          }
        });
        noticeObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
        window.addEventListener('offline', () => {
          const inspect = () => {
            paintedNotices.push([...document.querySelectorAll('[role="status"]')]
              .map((element) => element.textContent).filter(Boolean));
            if (paintedNotices.length < 4) requestAnimationFrame(inspect);
          };
          requestAnimationFrame(inspect);
        }, { once: true });
      });
      await context.setOffline(true);
      await page.locator('#live-room[data-online="false"]').waitFor();
      await page.waitForFunction((line) => document.querySelector('.wm-room-status-announcement')?.textContent === line, SYNC_STATUS.offline);
      await page.waitForFunction(() => paintedNotices.length === 4);
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        paintedNotices.push([...document.querySelectorAll('[role="status"]')]
          .map((element) => element.textContent).filter(Boolean));
      });
      const result = await page.evaluate(() => {
        noticeObserver.disconnect();
        return { committed: [...new Set(committedNotices)], painted: [...new Set(paintedNotices.flat())],
          current: [...document.querySelectorAll('[role="status"]')].map((element) => element.textContent).filter(Boolean) };
      });
      assert.deepEqual(result, { committed: [SYNC_STATUS.offline], painted: [SYNC_STATUS.offline], current: [SYNC_STATUS.offline] });
    });
  } finally { await context.close(); }
});
