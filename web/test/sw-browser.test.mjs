import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

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
