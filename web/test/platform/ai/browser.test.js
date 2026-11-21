import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

test('real browser holds one turn lock, recovers without waiting, omits credentials and rejects redirects', async () => {
  const captured = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Coach test</title>'); return; }
    if (path.startsWith('/src/')) {
      try { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(fileURLToPath(new URL(`../../../${path.slice(1)}`, import.meta.url)))); }
      catch { response.statusCode = 404; response.end(); }
      return;
    }
    captured.push({ path, cookie: request.headers.cookie ?? null, installation: request.headers['x-windmill-installation'] ?? null, authorization: request.headers.authorization ?? null });
    if (path === '/redirect') { response.writeHead(302, { Location: '/leak' }); response.end(); return; }
    if (path === '/v1/ai/passes') { response.setHeader('Content-Type', 'application/json'); response.end('{"pass":"private-pass","expiresIn":600000}'); return; }
    response.statusCode = 204; response.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies([{ name: 'wm_session', value: 'private-session', domain: '127.0.0.1', path: '/' }]);
    const first = await context.newPage(); const second = await context.newPage();
    await first.goto(origin); await second.goto(origin);
    await first.evaluate(async () => {
      const { browserRuntime } = await import('/src/platform/agent/runtime.js');
      window.runtime = browserRuntime();
      window.held = false;
      window.finished = window.runtime.withLock('one', { ifAvailable: false }, async (acquired) => {
        window.held = acquired;
        await new Promise((resolve) => { window.release = resolve; });
      });
    });
    await first.waitForFunction(() => window.held);
    assert.equal(await second.evaluate(async () => {
      const { browserRuntime } = await import('/src/platform/agent/runtime.js');
      return browserRuntime().withLock('one', { ifAvailable: true }, (acquired) => acquired);
    }), false);
    await first.evaluate(async () => { window.release(); await window.finished; });
    assert.equal(await second.evaluate(async () => {
      const { browserRuntime } = await import('/src/platform/agent/runtime.js');
      return browserRuntime().withLock('one', { ifAvailable: true }, (acquired) => acquired);
    }), true);
    const outcome = await first.evaluate(async () => {
      const { HttpAiTransport } = await import('/src/platform/ai/wire.js');
      const transport = new HttpAiTransport({ installation: () => 'private-installation' });
      await transport.pass({ client: 'web', use: 'vector.coach', version: 1 });
      await transport.request({ method: 'PUT', path: '/v1/pictures/AAAAAAAAAAAAAAAAAAAAAA', bytes: new Uint8Array([1]), mediaType: 'image/png', pass: 'private-pass' });
      try { await transport.request({ method: 'GET', path: '/redirect', pass: 'private-pass' }); return false; }
      catch { return true; }
    });
    assert.equal(outcome, true);
    assert.deepEqual(captured, [
      { path: '/v1/ai/passes', cookie: 'wm_session=private-session', installation: 'private-installation', authorization: null },
      { path: '/v1/pictures/AAAAAAAAAAAAAAAAAAAAAA', cookie: null, installation: null, authorization: 'Bearer private-pass' },
      { path: '/redirect', cookie: null, installation: null, authorization: 'Bearer private-pass' },
    ]);
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
});
