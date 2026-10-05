import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { ZERO_DIGEST, replaceRow } from '../../../src/platform/sync/core/digest.js';
import { Cursor } from '../../../src/platform/sync/core/wire.js';

let server, browser, origin;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const registryPath = fileURLToPath(new URL('../../../../packages/api-contract/sync/probe.registry.json', import.meta.url));
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-transport-test`, plugins: [{ name: 'transport-test-page', configureServer(server) {
    server.middlewares.use('/transport-test', (_request, response) => {
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Sync transport test</title>');
    });
  } }], optimizeDeps: { include: ['@noble/hashes/sha256', '@noble/hashes/utils'] },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => { await ready; await browser?.close(); await server?.close(); });

test('Chromium: the HTTP carrier calls captured native fetch with its browser receiver', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route('**/v1/sync/hello', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: '{"serverTime":1000,"epoch":"ep-native","as":null}' }));
    await page.goto(`${origin}/transport-test`);
    const response = await page.evaluate(async () => {
      const { HttpTransport } = await import('/src/platform/sync/transport.js');
      const transport = new HttpTransport({ schema: 4, fetch: window.fetch,
        reading: () => ({ wall: 1000, mono: 1000, boot: 'native' }) });
      return (await transport.request('hello')).response;
    });
    assert.deepEqual(response, { status: 200, body: { serverTime: 1000, epoch: 'ep-native', as: null } });
  } finally { await context.close(); }
});

for (const bound of ['count', 'bytes']) test(`Chromium: stalled live ${bound} overflow recovers by pull and persists the recovered rows`, async () => {
  await ready;
  const context = await browser.newContext();
  const sockets = [];
  const row = { t: 'card', id: 'card0001', seq: 1, rc: 10, ru: 10, born: '1:0:r_aaaaaaaaaaaa',
    life: ['alive', '1:0:r_aaaaaaaaaaaa'], f: { title: ['recovered', '1:0:r_aaaaaaaaaaaa'] } };
  const digest = replaceRow(ZERO_DIGEST, undefined, row);
  let recovering = false, pulls = 0;
  try {
    await context.routeWebSocket('**/v1/sync/live?schema=2', (socket) => {
      sockets.push(socket);
      socket.onMessage(() => {});
    });
    const page = await context.newPage();
    await page.route('**/v1/sync/hello', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ serverTime: Date.now(), epoch: 'ep-live', as: 'A', schema: 2, minSchema: 2, holdsRecords: { probe: false } }) }));
    await page.route('**/v1/sync/pull', async (route) => {
      pulls++;
      const request = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        serverTime: Date.now(), epoch: 'ep-live', as: 'A',
        pages: request.scopes.map(({ scope }) => ({ scope, kind: 'rows', rows: recovering && scope === 'self/probe' ? [row] : [],
          cursor: Cursor.encode({ e: 'ep-live', m: 'live', s: recovering && scope === 'self/probe' ? 1 : 0 }),
          more: false, seq: recovering && scope === 'self/probe' ? 1 : 0,
          digest: recovering && scope === 'self/probe' ? digest : ZERO_DIGEST })),
      }) });
    });
    await page.goto(`${origin}/transport-test`);
    await page.evaluate(async ({ registryPath, name }) => {
      const { BrowserSyncEngine } = await import('/src/platform/sync/engine.js');
      const { Registry } = await import('/src/platform/sync/core/registry.js');
      const probe = await (await fetch(`/@fs${registryPath}`)).json();
      window.failures = [];
      window.engine = await BrowserSyncEngine.open({ name, registry: new Registry(probe), base: '', draw: () => 100,
        telemetry: { failure(name) { window.failures.push(name); }, event() {} } });
      window.observation = engine.observe('self/probe');
      window.signedin = await engine.signIn('A');
      await engine.start();
    }, { registryPath, name: `live-${bound}` });
    await page.waitForFunction(() => engine.live.socket?.readyState === 1 && engine.device.activeReplica.cursors['self/probe']?.booted,
      undefined, { timeout: 5000 }).catch(async () => {
      throw new Error(JSON.stringify({ sockets: sockets.length, pulls, browser: await page.evaluate(() => ({
        meta: engine.device.activeReplica.meta, cursors: engine.device.activeReplica.cursors,
        leader: engine.leader, snapshot: engine.getSnapshot(), live: engine.live.socket?.readyState, signedin, failures,
      })) }));
    });
    await page.evaluate(() => {
      window.liveFrames = 0;
      const original = engine.live.onFrame;
      window.releaseLive = null;
      const blocked = new Promise((resolve) => { window.releaseLive = resolve; });
      engine.live.onFrame = async (frame) => { window.liveFrames++; await blocked; return original(frame); };
    });
    const before = pulls;
    recovering = true;
    const frame = JSON.stringify({ op: 'change', as: 'A', scope: 'self/probe', epoch: 'ep-live', seq: 1,
      padding: bound === 'bytes' ? 'é'.repeat(30_000) : '' });
    const total = bound === 'count' ? 65 : Math.floor(1_048_576 / new TextEncoder().encode(frame).length) + 1;
    for (let i = 0; i < total; i++) sockets[0].send(frame);
    await page.waitForFunction(() => observation.getSnapshot().drawn.some((row) => row.id === 'card0001'), undefined, { timeout: 5000 });
    assert.ok(pulls > before, 'overflow must request a pull while live processing remains stalled');
    assert.deepEqual(await page.evaluate(() => ({ frames: liveFrames, queued: engine.live.frames.length,
      bytes: engine.live.queuedBytes, stored: observation.getSnapshot().stored })),
    { frames: 1, queued: 0, bytes: 0, stored: [row] });
    await context.setOffline(true);
    const persisted = await page.evaluate(async (name) => {
      const Constructor = engine.constructor, registry = engine.registry;
      engine.close(); releaseLive();
      window.engine = await Constructor.open({ name, registry, telemetry: { failure() {}, event() {} } });
      return engine.observe('self/probe').getSnapshot().stored;
    }, `live-${bound}`);
    assert.deepEqual(persisted, [row]);
  } finally { await context.close(); }
});
