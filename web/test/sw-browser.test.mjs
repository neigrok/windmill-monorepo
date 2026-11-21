import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

const worker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
let server, browser, origin, deployed = 'old', failure = '', requests = [];
const ready = (async () => {
  server = createServer((request, response) => {
    const path = request.url;
    requests.push(path);
    response.setHeader('Cache-Control', 'no-store');
    if (path === '/sw.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(worker); return; }
    if (path === '/offline-assets.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify([`/assets/${deployed}.js`, `/assets/${deployed}.css`])); return;
    }
    if (path === `/assets/${deployed}.css` && failure === 'stall') return;
    if (path === `/assets/${deployed}.css` && failure === 'stalled-body') {
      response.setHeader('Content-Type', 'text/css'); response.write('body {'); return;
    }
    if (path === `/assets/${deployed}.css` && failure) { response.writeHead(503); response.end('unavailable'); return; }
    if (path.startsWith('/assets/') && path.endsWith('.js')) {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(`document.body.dataset.room = ${JSON.stringify(path.includes('old') ? 'old' : 'new')};`); return;
    }
    if (path.startsWith('/assets/') && path.endsWith('.css')) {
      response.setHeader('Content-Type', 'text/css'); response.end('body { color: rgb(1, 2, 3) }'); return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><title>${deployed}</title><link rel="stylesheet" href="/assets/${deployed}.css"><body>${deployed}<script type="module" src="/assets/${deployed}.js"></script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => {
  await ready;
  await browser?.close();
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
});
async function pointer(page) {
  return page.evaluate(async () => (await (await caches.open('windmill-shell-v2')).match('/offline-generation'))?.json());
}
async function refresh(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error('refresh acknowledgement timed out')), 20000);
    channel.port1.onmessage = (event) => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
    navigator.serviceWorker.controller.postMessage({ type: 'refresh-shell' }, [channel.port2]);
  }));
}
async function open(context) {
  const page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  assert.deepEqual(await refresh(page), { ok: true });
  await page.waitForFunction(() => document.body.dataset.room === 'old');
  return page;
}

test('Chromium: failed or stalled deployment assets keep the previous complete offline shell', async () => {
  await ready;
  for (const failedAsset of ['missing', 'stall', 'stalled-body']) {
    deployed = 'old'; failure = ''; requests = [];
    const context = await browser.newContext();
    try {
      const page = await open(context);
      const before = await pointer(page);
      deployed = 'new'; failure = failedAsset;
      assert.deepEqual(await refresh(page), { ok: false });
      assert.deepEqual(await pointer(page), before);
      await context.setOffline(true);
      await page.reload({ waitUntil: 'load' });
      assert.equal(await page.title(), 'old');
      assert.equal(await page.evaluate(() => document.body.dataset.room), 'old');
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).color), 'rgb(1, 2, 3)');
      assert.ok(!requests.some((url) => /wasm|embedder|models/.test(url)), 'shell preparation must not fetch neural runtime');
    } finally { await context.close(); }
  }
});

test('Chromium: explicit refresh promotes a complete deployment and preserves the previous generation', async () => {
  await ready;
  deployed = 'old'; failure = '';
  const context = await browser.newContext();
  try {
    const page = await open(context);
    const before = await pointer(page);
    deployed = 'new';
    assert.deepEqual(await refresh(page), { ok: true });
    const current = await pointer(page);
    assert.notEqual(current.current, before.current);
    assert.equal(current.previous, before.current);
    await context.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    assert.equal(await page.title(), 'new');
    assert.equal(await page.evaluate(() => document.body.dataset.room), 'new');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).color), 'rgb(1, 2, 3)');
    assert.equal(await page.evaluate(async (name) => !!(await (await caches.open(name)).match('/assets/old.js')), before.current), true);
  } finally { await context.close(); }
});

// The beacon's last batch and the engine's last push leave as the page hides, while it is going away.
for (const [engine, launcher] of [['Chromium', chromium], ['WebKit', webkit]]) {
  test(`${engine}: a page the worker controls delivers the beacon and the keepalive request it sends as it hides`, { timeout: 90_000 }, async (t) => {
    const delivered = [];
    const site = createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      if (request.url === '/v1/events') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        delivered.push(...JSON.parse(Buffer.concat(chunks).toString()).events.map((event) => event.name));
        response.writeHead(202, { 'Content-Type': 'application/json' });
        response.end('{}');
        return;
      }
      if (request.url === '/sw.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(worker); return; }
      if (request.url === '/offline-assets.json') { response.setHeader('Content-Type', 'application/json'); response.end('["/assets/room.js"]'); return; }
      if (request.url === '/assets/room.js') { response.setHeader('Content-Type', 'text/javascript'); response.end('document.body.dataset.room = "ready";'); return; }
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>room</title><body><script type="module" src="/assets/room.js"></script>');
    });
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { site.closeAllConnections(); site.close(resolve); }));
    const at = `http://127.0.0.1:${site.address().port}`;
    const launched = await launcher.launch({ headless: true });
    t.after(() => launched.close());
    const page = await (await launched.newContext()).newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(`${at}/app`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });

    const trials = 5;
    const wanted = [];
    for (let trial = 0; trial < trials; trial++) {
      await page.goto(`${at}/app/${trial}`);
      await page.waitForFunction(() => document.body.dataset.room === 'ready');
      assert.equal(await page.evaluate(() => navigator.serviceWorker.controller !== null), true, 'the worker controls the page');
      await page.evaluate((trial) => addEventListener('pagehide', () => {
        const body = (name) => JSON.stringify({ sessionKey: 'leaving', events: [{ name, clientMs: Date.now() }] });
        navigator.sendBeacon('/v1/events', new Blob([body(`beacon_${trial}`)], { type: 'application/json' }));
        fetch('/v1/events', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: body(`keepalive_${trial}`) }).catch(() => {});
      }), trial);
      wanted.push(`beacon_${trial}`, `keepalive_${trial}`);
    }
    await page.goto(`${at}/elsewhere`);

    const end = Date.now() + 10_000;
    while (delivered.length < wanted.length && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(delivered.sort(), wanted.sort());
  });
}

// The worker behind a listener of its own that answers `seen` with every request the worker was handed since it last asked.
test('Chromium: only /v1/ skips the worker; the rest still reaches its fetch handler, the shell still serves offline, and an API request offline still fails', { timeout: 90_000 }, async (t) => {
  await ready;
  const observed = `const seen = [];
self.addEventListener('fetch', (event) => { seen.push(\`\${event.request.mode === 'navigate' ? 'navigate' : event.request.method} \${new URL(event.request.url).pathname}\`); });
self.addEventListener('message', (event) => { if (event.data?.type === 'seen') event.ports[0].postMessage(seen.splice(0)); });
${worker}`;
  let reachable = true;
  const site = createServer((request, response) => {
    const path = request.url.split('?')[0];
    if (!reachable) { request.socket.destroy(); return; }
    response.setHeader('Cache-Control', 'no-store');
    if (path === '/sw.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(observed); return; }
    if (path === '/offline-assets.json') { response.setHeader('Content-Type', 'application/json'); response.end('["/assets/room.js"]'); return; }
    if (path === '/assets/room.js') { response.setHeader('Content-Type', 'text/javascript'); response.end('document.body.dataset.room = "ready";'); return; }
    if (/^\/(v1|mcp|oauth\/token|og|models|favicon)/.test(path) && request.headers['sec-fetch-mode'] !== 'navigate') {
      response.setHeader('Content-Type', 'application/json'); response.end('{}'); return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><title>${path}</title><body>${path === '/' ? '<script type="module" src="/assets/room.js"></script>' : ''}`);
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { site.closeAllConnections(); site.close(resolve); }));
  const at = `http://127.0.0.1:${site.address().port}`;
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(`${at}/app`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  assert.deepEqual(await refresh(page), { ok: true });
  const seen = () => page.evaluate(() => new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => { channel.port1.close(); resolve(event.data); };
    navigator.serviceWorker.controller.postMessage({ type: 'seen' }, [channel.port2]);
  }));
  await seen();

  const fetched = await page.evaluate(async () => {
    const asked = [['GET', '/v1/me'], ['POST', '/v1/sync/push'], ['GET', '/mcp'], ['POST', '/oauth/token'], ['GET', '/og/t_one.png'],
      ['GET', '/models/model.onnx'], ['GET', '/assets/room.js'], ['GET', '/favicon.svg']];
    const answered = [];
    for (const [method, path] of asked) answered.push(`${method} ${path} ${(await fetch(path, { method, ...(method === 'POST' ? { body: '{}' } : {}) })).status}`);
    return answered;
  });
  assert.deepEqual(fetched, ['GET /v1/me 200', 'POST /v1/sync/push 200', 'GET /mcp 200', 'POST /oauth/token 200', 'GET /og/t_one.png 200',
    'GET /models/model.onnx 200', 'GET /assets/room.js 200', 'GET /favicon.svg 200']);
  const served = [];
  for (const path of ['/oauth/authorize', '/og/t_one', '/mcp', '/v1/auth/google/start', '/app/roadmap']) {
    served.push(`${path} ${(await page.goto(`${at}${path}`)).fromServiceWorker() ? 'worker' : 'network'}`);
  }
  assert.deepEqual(served, ['/oauth/authorize worker', '/og/t_one worker', '/mcp worker', '/v1/auth/google/start network', '/app/roadmap worker']);
  assert.deepEqual(await seen(), ['GET /mcp', 'POST /oauth/token', 'GET /og/t_one.png', 'GET /models/model.onnx', 'GET /assets/room.js', 'GET /favicon.svg',
    'navigate /oauth/authorize', 'navigate /og/t_one', 'navigate /mcp', 'navigate /app/roadmap']);

  reachable = false;
  await context.setOffline(true);
  for (const path of ['/app/journal', '/oauth/authorize']) {
    const shell = await page.goto(`${at}${path}`);
    await page.waitForFunction(() => document.body.dataset.room === 'ready');
    assert.deepEqual([shell.fromServiceWorker(), await page.title()], [true, '/'], `offline, ${path} opens the cached shell`);
  }
  const failed = await page.evaluate(() => Promise.all([fetch('/v1/me'), fetch('/v1/sync/push', { method: 'POST', body: '{}', keepalive: true })]
    .map((sent) => sent.then((response) => `answered ${response.status}`, (error) => `${error.name}: ${error.message}`))));
  assert.deepEqual(failed, ['TypeError: Failed to fetch', 'TypeError: Failed to fetch'], 'offline, the API fails as a lost connection');
  await assert.rejects(page.goto(`${at}/v1/auth/google/start`), /ERR_INTERNET_DISCONNECTED/);
});
