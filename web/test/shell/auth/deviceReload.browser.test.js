import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beacon, withBrowserErrors } from '../../products/roadmap/browserFixture.js';
import { scene } from '../../products/roadmap/skillTreeViewHost.js';
import { LOAD_ERROR } from '../../../src/products/roadmap/copy.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const reference = fileURLToPath(new URL('../../../../packages/api-contract/sync/reference/', import.meta.url));
const registryPath = fileURLToPath(new URL('../../../../packages/api-contract/sync/probe.registry.json', import.meta.url));
let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-device-reload-test`, plugins: [{
    name: 'device-holder-fixture', enforce: 'pre',
    configureServer(server) {
      server.middlewares.use('/device-test', (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><div id="root"></div><script type="module" src="/device-test-fixture.js"></script>');
      });
    },
    resolveId(id, importer) {
      if (id === '/device-test-fixture.js') return id;
      const file = id.startsWith('.') && importer ? resolve(dirname(importer), id) : id;
      if (file.endsWith('/scene/SkillTreeScene.js')) return '\0device-scene';
      if (file.endsWith('/shell/auth/SignInDoor.jsx')) return '\0device-signin';
      if (file.endsWith('/telemetry/beacon.js')) return '\0device-events';
      if (file.endsWith('/telemetry/sentry.js')) return '\0device-issues';
    },
    load(id) {
      if (id === '\0device-scene') return scene;
      if (id === '\0device-signin') return 'const open = () => {}; export const useSignInDoor = () => open; export const useSignInDoorHost = () => () => {};';
      if (id === '\0device-events') return beacon;
      if (id === '\0device-issues') return 'export function captureError(product, operation) { (window.issues ??= []).push(operation); }';
      if (id !== '/device-test-fixture.js') return;
      return `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import AuthProvider, { useAuth } from '/src/shell/auth/AuthProvider.jsx';
        import { SkillTreeView } from '/src/products/roadmap/SkillTreeView.jsx';
        import { HttpTreeRepository } from '/src/products/roadmap/persistence/HttpTreeRepository.js';
        import { LocalTreeRegistry } from '/src/products/roadmap/persistence/LocalTreeRegistry.js';
        import { SyncSession } from '/src/products/roadmap/sync/SyncSession.js';
        import { SyncStore } from '/src/products/roadmap/sync/SyncStore.js';
        import { syncSession } from '/src/platform/sync/session.js';
        import { BrowserSyncEngine } from '/src/platform/sync/engine.js';
        import { Registry } from '/@fs${reference}core/registry.js';
        import { PRODUCTS } from '/src/shell/products.js';
        PRODUCTS.push({ id: 'probe', sync: { signedOutWork: { type: 'card', one: 'card', many: 'cards' } } });
        import '/src/styles/global.css';
        window.events = []; window.issues = []; window.sent = [];
        window.ceremonies = []; window.revealed = []; window.revealFrames = []; window.cameraCalls = [];
        window.deviceStore = new SyncStore();
        window.deviceIndex = new LocalTreeRegistry();
        HttpTreeRepository.prototype.loadTree = async () => null;
        HttpTreeRepository.prototype.loadProgress = async () => ({ completed: new Set(), completedAt: {}, server: false });
        HttpTreeRepository.prototype.loadActivity = async () => [];
        SyncSession.prototype.connect = function () {
          const session = this;
          window.roadmapSession = session;
          this.ws = { readyState: WebSocket.OPEN, close() {
            this.readyState = WebSocket.CLOSED;
            session.phase = 'offline';
            session.inFlight.clear();
            session.progressInFlight.clear();
            session.structureWrites.clear();
            session.progressWrites.clear();
            session.emitStatus();
            queueMicrotask(() => { if (!session.closed) session.connect(); });
          },
            send(value) { window.sent.push(JSON.parse(value)); } };
          if (window.serverAccount === 'A') this.receiveState({ nodes: [], edges: [], kinds: [], seq: 0 });
          return this;
        };
        function Room() {
          const auth = useAuth(); window.auth = auth;
          const [hash, setHash] = React.useState(location.hash);
          React.useEffect(() => {
            const changed = () => setHash(location.hash);
            addEventListener('hashchange', changed);
            return () => removeEventListener('hashchange', changed);
          }, []);
          return React.createElement(React.Fragment, null,
            React.createElement('output', { id: 'auth-state' }, auth.status + ':' + auth.lapsed),
            hash === '#/app/t_kept' && React.createElement(SkillTreeView, { treeId: 't_kept' }));
        }
        window.mountDevice = async (name, account, seed, interruption = null) => {
          window.holdsProbe = interruption === 'question';
          window.rejectHello = false;
          window.serverAccount = account;
          const registry = new Registry(await (await fetch('/@fs${registryPath}')).json());
          window.engine = await BrowserSyncEngine.open({ name, registry,
            transport: { request: async (endpoint) => ({ response: endpoint === 'hello' && !window.rejectHello
              ? { status: 200, body: { serverTime: Date.now(), epoch: 'test', as: window.serverAccount,
                schema: registry.version, minSchema: registry.minVersion, holdsRecords: { probe: window.holdsProbe } } }
              : { status: 503, body: {} }, timing: { send: engine.reading(), recv: engine.reading() } }),
              openLive() { return { close() {} }; } },
            telemetry: { failure(operation) { issues.push(operation); }, event() {} } });
          syncSession.engine = engine;
          syncSession.opening = Promise.resolve(engine);
          syncSession.open = (options) => { engine.credentials = options.credentials; return syncSession.opening; };
          syncSession.publish({ engine, ready: true, online: true });
          if (seed) {
            deviceIndex.record('t_kept', 'Kept roadmap', 'A');
            deviceIndex.attribute(['t_kept'], 'A');
            const session = new SyncSession({ treeId: 't_kept', title: 'Kept roadmap' });
            session.seed({ id: 't_kept', title: 'Kept roadmap', kinds: [], nodes: [
              { id: 'kept_step', label: 'Kept device step', prerequisites: [], color: 'olive' },
            ] });
            await session.persistNow();
          }
          window.deviceRoot = createRoot(document.getElementById('root'));
          deviceRoot.render(React.createElement(AuthProvider, null, React.createElement(Room)));
        };
      `;
    },
  }], optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => { try { await ready; } finally { await browser?.close(); await server?.close(); } });

for (const reload of [false, true]) for (const returning of ['A', 'B']) {
  test(`device copy: lapse${reload ? ' + reload' : ''} + ${returning === 'A' ? 'same' : 'different'} account`, async () => {
    await ready;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      let account = 'A';
      await context.route('**/v1/**', (route) => {
        const path = new URL(route.request().url()).pathname;
        const body = path === '/v1/me' ? { user: account ? { id: account, name: account } : null }
          : path === '/v1/trees' ? { trees: [] } : { enabled: false, runs: [] };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      const page = await context.newPage();
      await withBrowserErrors(page, async () => {
        const name = `device-lapse-${reload}-${returning}`;
        await page.goto(`${origin}/device-test#/app/t_kept`);
        await page.waitForFunction(() => typeof mountDevice === 'function');
        await page.evaluate((name) => mountDevice(name, 'A', true), name);
        await page.locator('.st-board-card-title').filter({ hasText: 'Kept device step' }).waitFor();
        await page.waitForFunction(() => document.getElementById('auth-state').textContent === 'signed-in:false');
        await page.waitForFunction(() => window.roadmapSession?.phase === 'live' && sent.some((frame) => frame.t === 'subgraph' && frame.nodes.some((node) => node.id === 'kept_step')));
        account = null;
        await page.evaluate(async () => { serverAccount = null; await auth.refresh(); await roadmapSession.persistNow(); });
        await page.waitForFunction(() => document.getElementById('auth-state').textContent === 'ghost:true');
        assert.deepEqual(await page.evaluate(() => deviceStore.treeIds()), ['t_kept']);
        if (reload) {
          await page.reload();
          await page.waitForFunction(() => typeof mountDevice === 'function');
          await page.evaluate((name) => mountDevice(name, null, false), name);
          await page.waitForFunction(() => document.getElementById('auth-state').textContent === 'ghost:true');
          await page.getByRole('button', { name: LOAD_ERROR.action, exact: true }).waitFor();
          assert.deepEqual(await page.evaluate(() => deviceStore.treeIds()), ['t_kept']);
        }
        account = returning;
        await page.evaluate(async (account) => { sent = []; serverAccount = account; await auth.signIn({ id: account, name: account }); }, returning);
        await page.waitForFunction(() => document.getElementById('auth-state').textContent === 'signed-in:false');
        if (returning === 'A') {
          await page.locator('.st-board-card-title').filter({ hasText: 'Kept device step' }).waitFor();
          await page.waitForFunction(() => sent.some((frame) => frame.t === 'subgraph' && frame.nodes.some((node) => node.id === 'kept_step')));
          assert.equal(await page.getByRole('button', { name: LOAD_ERROR.action, exact: true }).count(), 0);
          assert.deepEqual(await page.evaluate(() => deviceStore.treeIds()), ['t_kept']);
          assert.equal(await page.evaluate(() => engine.device.activeReplica.meta.account), 'A');
        } else {
          await page.waitForURL(`${origin}/device-test#/app`);
          await page.waitForFunction(async () => (await deviceStore.treeIds()).length === 0);
          assert.deepEqual(await page.evaluate(() => deviceIndex.entries()), {});
          assert.deepEqual(await page.evaluate(() => deviceStore.treeIds()), []);
          assert.deepEqual(await page.evaluate(() => sent), []);
          await page.locator('.st-board-card-title').waitFor({ state: 'detached' });
          assert.equal(await page.locator('.st-board-card-title').count(), 0);
        }
        assert.deepEqual(await page.evaluate(() => issues), []);
      });
    } finally { await context.close(); }
  });
}


for (const interruption of ['question', 'handshake', 'signout']) {
  test(`device cleanup survives a reload after the replica transition during ${interruption}`, async () => {
    await ready;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      let account = 'A';
      await context.route('**/v1/**', (route) => {
        const path = new URL(route.request().url()).pathname;
        const body = path === '/v1/me' ? { user: account ? { id: account, name: account } : null }
          : path === '/v1/trees' ? { trees: [] } : { enabled: false, runs: [] };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      const page = await context.newPage();
      await withBrowserErrors(page, async () => {
        const name = `device-interruption-${interruption}`;
        await page.goto(`${origin}/device-test#/app/t_kept`);
        await page.waitForFunction(() => typeof mountDevice === 'function');
        await page.evaluate((name) => mountDevice(name, 'A', true), name);
        await page.locator('.st-board-card-title').filter({ hasText: 'Kept device step' }).waitFor();
        await page.waitForFunction(() => document.getElementById('auth-state').textContent === 'signed-in:false');
        await page.waitForFunction(() => window.roadmapSession?.phase === 'live');
        account = interruption === 'signout' ? null : 'B';
        const interrupted = await page.evaluate(async ({ interruption, account }) => {
          deviceRoot.unmount();
          serverAccount = account;
          await engine.finishSignOut({ choice: 'keep', deviceCleanup: true });
          if (interruption === 'signout') return { complete: true };
          if (interruption === 'question') {
            holdsProbe = true;
            await engine.commit('self/probe', [{ op: 'create', t: 'card', id: 'anon0001', f: { title: 'Anonymous work' } }]);
          } else rejectHello = true;
          return engine.signIn('B');
        }, { interruption, account });
        assert.equal(interrupted.complete, interruption === 'signout');
        if (interruption === 'question') assert.equal(interrupted.due[0].kind, 'signed-out');
        if (interruption === 'handshake') assert.equal(interrupted.authPaused, true);
        const cleanup = await page.evaluate(() => engine.device.meta.deviceCleanup);
        assert.equal(cleanup.previous, 'A');
        assert.equal(Number.isSafeInteger(cleanup.generation) && cleanup.generation > 0, true);
        assert.deepEqual(Object.keys(cleanup).sort(), ['generation', 'previous']);
        assert.deepEqual(await page.evaluate(() => deviceStore.treeIds()), ['t_kept']);
        await page.reload();
        await page.waitForFunction(() => typeof mountDevice === 'function');
        await page.evaluate(({ name, account, interruption }) => mountDevice(name, account, false, interruption), { name, account, interruption });
        await page.waitForFunction(async () => engine.device.meta.deviceCleanup === undefined && (await deviceStore.treeIds()).length === 0);
        assert.deepEqual(await page.evaluate(() => deviceIndex.entries()), {});
        assert.deepEqual(await page.evaluate(() => deviceStore.treeIds()), []);
        if (interruption === 'question') {
          const dialog = page.getByRole('dialog');
          await dialog.waitFor();
          await dialog.getByRole('button', { name: 'Add', exact: true }).click();
        }
        await page.waitForFunction((expected) => document.getElementById('auth-state').textContent === expected,
          interruption === 'signout' ? 'ghost:false' : 'signed-in:false');
        assert.deepEqual(await page.evaluate(() => issues), []);
      });
    } finally { await context.close(); }
  });
}
