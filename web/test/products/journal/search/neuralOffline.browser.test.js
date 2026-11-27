import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';

// The built app, its service worker and the self-hosted weights, served signed out with no backend behind them.
const web = fileURLToPath(new URL('../../../../', import.meta.url));
const weights = '/models/Xenova/bge-small-en-v1.5/onnx/model_quantized.onnx';
const missing = existsSync(join(web, 'public', weights)) ? false : 'the self-hosted weights are absent: run node scripts/fetch-model.mjs';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
// Playwright's offline context leaves a service worker's own fetches online, so the server refuses everything while
// `reachable` is false: what the page gets then came from the worker's caches. The build reports to a Sentry the test
// answers, so a report the page sends is seen.
let dist, server, browser, origin, reachable = true, refused = 0;
const sentry = 'https://0123456789abcdef@sentry.test/1';

const ready = missing ? Promise.resolve() : (async () => {
  dist = mkdtempSync(join(tmpdir(), 'wm-journal-search-'));
  process.env.VITE_SENTRY_DSN = sentry;
  await build({ root: web, configFile: join(web, 'vite.config.js'), logLevel: 'error', publicDir: false,
    build: { outDir: dist, emptyOutDir: true } });
  delete process.env.VITE_SENTRY_DSN;
  server = createServer((request, response) => {
    if (!reachable) { refused++; request.socket.destroy(); return; }
    const path = decodeURIComponent(request.url.split('?')[0]);
    response.setHeader('Cache-Control', 'no-store');
    if (path === '/v1/me') { response.writeHead(401, { 'Content-Type': 'application/json' }); response.end('{"error":"sign in"}'); return; }
    if (path.startsWith('/v1/')) { response.writeHead(204); response.end(); return; }
    const served = (candidate) => !path.includes('..') && existsSync(candidate) && statSync(candidate).isFile();
    const file = [join(dist, path), join(web, 'public', path)].find(served)
      ?? (path === '/' || path.startsWith('/app') ? join(dist, 'index.html') : null);
    if (!file) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => {
  await ready.catch(() => {});
  await browser?.close();
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  if (dist) rmSync(dist, { recursive: true, force: true });
});

async function journal(context) {
  await ready;
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`${origin}/app/journal`);
  await page.getByRole('textbox', { name: 'Write today' }).waitFor();
  return page;
}
async function eventually(page, check, argument) {
  for (const end = Date.now() + 30_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) {
    if (await page.evaluate(check, argument)) return;
  }
  throw new Error(`never held: ${check}`);
}
async function shellKept(page) {
  await eventually(page, async () => {
    const pointer = await (await (await caches.open('windmill-shell-v2')).match('/offline-generation'))?.json();
    return !!navigator.serviceWorker.controller && !!pointer && !!(await (await caches.open(pointer.current)).match('/'));
  });
}
async function disconnect(context) {
  reachable = false;
  refused = 0;
  await context.setOffline(true);
}
async function search(page, query) {
  await page.getByRole('button', { name: 'Search a feeling', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search a feeling' }).fill(query);
}
const foot = (page) => page.locator('.journal-search-foot');

test('Chromium: search by meaning, once used, works again after a reload with no connection', { skip: missing, timeout: 110_000 }, async () => {
  await ready;
  const context = await browser.newContext();
  const elsewhere = new Set();
  context.on('request', (request) => { if (!request.url().startsWith(origin)) elsewhere.add(new URL(request.url()).origin); });
  try {
    const page = await journal(context);
    await shellKept(page);
    await page.getByRole('textbox', { name: 'Write today' }).fill('I walked along the sea at dusk and felt calm.');
    await page.locator('.journal-saved.is-on').waitFor({ state: 'attached' });
    await search(page, 'peaceful evening by the ocean');
    await foot(page).filter({ hasText: 'Matched by meaning, on your device.' }).waitFor({ timeout: 60_000 });
    await page.locator('.journal-search-hit').first().waitFor();
    await eventually(page, async (weights) => !!(await (await caches.open('windmill-models-v1')).match(weights)), weights);
    await page.keyboard.press('Escape');

    await disconnect(context);
    await page.reload();
    await page.getByRole('textbox', { name: 'Write today' }).waitFor();
    await search(page, 'peaceful evening by the ocean');
    await foot(page).filter({ hasText: 'Matched by meaning, on your device.' }).waitFor({ timeout: 60_000 });
    assert.match(await page.locator('.journal-search-hit').first().textContent(), /I walked along the sea at dusk/);
    assert.deepEqual([...elsewhere], [], 'search by meaning asks no other host for its runtime or weights');
  } finally { reachable = true; await context.close(); }
});

test('Chromium: before its first use, with no connection, search by meaning says it needs one', { skip: missing, timeout: 60_000 }, async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const page = await journal(context);
    await shellKept(page);
    await disconnect(context);
    await page.reload();
    await page.getByRole('textbox', { name: 'Write today' }).waitFor();
    await search(page, 'calm');
    await foot(page).filter({ hasText: 'Search by meaning needs a connection the first time' }).waitFor();
    assert.ok(refused > 0, 'the search reached for what it has not kept');
  } finally { reachable = true; await context.close(); }
});

test('Chromium: signed out, with the server out of reach and the browser online, search by meaning says it needs a connection and reports nothing', { skip: missing, timeout: 60_000 }, async () => {
  await ready;
  const context = await browser.newContext();
  const reports = [];
  await context.route('https://sentry.test/**', (route) => { reports.push(route.request().url()); return route.fulfill({ status: 200, body: '{}' }); });
  try {
    const page = await journal(context);
    await shellKept(page);
    reachable = false;
    refused = 0;
    await page.reload();
    await page.getByRole('textbox', { name: 'Write today' }).waitFor();
    await search(page, 'calm');
    await foot(page).filter({ hasText: 'Search by meaning needs a connection the first time' }).waitFor();
    assert.deepEqual({ online: await page.evaluate(() => navigator.onLine), reached: refused > 0, reports },
      { online: true, reached: true, reports: [] });
  } finally { reachable = true; await context.close(); }
});

test('Chromium: with the connection back, reopening search brings meaning that needed one', { skip: missing, timeout: 110_000 }, async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const page = await journal(context);
    await shellKept(page);
    await page.getByRole('textbox', { name: 'Write today' }).fill('I walked along the sea at dusk and felt calm.');
    await page.locator('.journal-saved.is-on').waitFor({ state: 'attached' });
    await disconnect(context);
    await page.reload();
    await page.getByRole('textbox', { name: 'Write today' }).waitFor();
    await search(page, 'peaceful evening by the ocean');
    await foot(page).filter({ hasText: 'Search by meaning needs a connection the first time' }).waitFor();
    await page.keyboard.press('Escape');

    reachable = true;
    await context.setOffline(false);
    await search(page, 'peaceful evening by the ocean');
    await foot(page).filter({ hasText: 'Matched by meaning, on your device.' }).waitFor({ timeout: 60_000 });
    assert.match(await page.locator('.journal-search-hit').first().textContent(), /I walked along the sea at dusk/);
  } finally { reachable = true; await context.close(); }
});

test('the build keeps search by meaning\'s worker and runtime out of the offline shell', { skip: missing }, async () => {
  await ready;
  const shell = JSON.parse(readFileSync(join(dist, 'offline-assets.json'), 'utf8'));
  assert.deepEqual(shell.filter((url) => /embedder\.worker|ort-wasm|transformers/.test(url)), []);
  assert.ok(shell.some((url) => /\/assets\/JournalApp-[\w-]+\.js$/.test(url)), 'the journal room, which holds the model\'s door, is in the shell');
});
