// Kept here in Chromium, over the browser engine on the page's own IndexedDB: each change that cannot land is told to
// the intake once, and each notice no rule lists is reported once, however often the engine republishes its notices,
// with storage refused (once a page load) and with storage kept (once on this browser, past two hundred notices); and a
// kept change's Discard reports a failure once under the list's own name, and closes quietly on a notice the engine no
// longer holds.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { beacon } from '../browserFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/global.css';
import { BrowserSyncEngine } from '/src/platform/sync/engine.js';
import { registry } from '/src/platform/sync/schema.js';
import { syncSession } from '/src/platform/sync/session.js';
import { KeptHere } from '/src/products/roadmap/kept/KeptHere.jsx';
import { KeptList } from '/src/products/roadmap/kept/KeptList.jsx';

const stamp = '1000:0:r_aaaaaaaaaaaa';
const reading = () => ({ wall: Date.now(), mono: Math.floor(performance.now()), boot: 'kept' });
const hello = { status: 200, body: { serverTime: Date.now(), epoch: 'ep-1', as: 'A', schema: registry.version, minSchema: registry.minVersion,
  holdsRecords: Object.fromEntries(Object.keys(registry.products).map((product) => [product, false])), holdings: {} } };
const transport = {
  request: async (endpoint) => {
    if (endpoint !== 'hello') throw new Error('offline');
    return { response: hello, timing: { send: reading(), recv: reading() } };
  },
  openLive() { throw new Error('offline'); },
};
window.events = [];
window.issues = [];
// The account's engine, bound and never started, so nothing but the page writes to it.
window.engineReady = (async () => {
  const engine = await BrowserSyncEngine.open({ name: 'kept-test', registry, transport, telemetry: { event() {}, failure() {} } });
  if (engine.device.activeReplica.meta.state !== 'bound') await engine.signIn('A');
  syncSession.engine = engine;
  syncSession.publish({ engine, ready: true, signedIn: true });
  window.engine = engine;
})();
window.notice = (n, code = 'scope-dead') => ({ id: 'notice:g' + n + '/0', scope: 'tree/t_0000000000000001', code,
  content: { d: [{ t: 'node', id: 'n' + n, f: { label: ['Step ' + n, stamp], description: ['Words of step ' + n, stamp] } }] }, at: 1800000000000 });
window.keep = (notices) => window.engine.write(null, (device) => { device.activeReplica.notices.push(...notices); });
// A write that changes nothing roadmap's notices hold.
window.unrelated = (n) => window.engine.write(null, (device) => {
  device.activeReplica.deviceRows('roadmap')['landing:t_0000000000000009'] = { nodes: ['u' + n], edges: [], revived: [], names: [] };
});
window.mountHere = () => createRoot(document.getElementById('fixture')).render(React.createElement(KeptHere));
// The list over the engine, its Discard answered by \`dismiss\`.
window.mountList = (dismiss) => {
  const engine = window.engine;
  const notices = engine.observeNotices('roadmap').getSnapshot().notices;
  const door = { registry: engine.registry, observe: (scope) => engine.observe(scope), dismissNotice: dismiss };
  createRoot(document.getElementById('fixture')).render(React.createElement(KeptList, { engine: door, notices, onClose: () => { window.closed = true; } }));
};
window.entryReady = true;
`;
const sentry = 'export function captureError(kind, operation, stack, route, tags = {}) { window.issues.push({ operation, tags }); }';

let server, browser, origin, ready;
function start() {
  ready ??= (async () => {
    server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-kept-test`, logLevel: 'error',
      plugins: [{ name: 'kept-test', enforce: 'pre',
        resolveId(id) {
          if (id === '/kept-entry.js') return '\0kept-entry';
          if (id.endsWith('/telemetry/beacon.js')) return '\0kept-beacon';
          if (id.endsWith('/telemetry/sentry.js')) return '\0kept-sentry';
        },
        load(id) {
          if (id === '\0kept-entry') return entry;
          if (id === '\0kept-beacon') return beacon;
          if (id === '\0kept-sentry') return sentry;
        },
        configureServer(vite) {
          vite.middlewares.use('/kept-test', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="fixture"></div><script type="module" src="/kept-entry.js"></script>');
          });
        },
      }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
      server: { host: '127.0.0.1', port: 0 } });
    await server.listen(0);
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
  })();
  return ready;
}
after(async () => { await browser?.close(); await server?.close(); });

// One browser context, its own IndexedDB and storage; `refused` makes every reach for localStorage throw.
async function withContext({ refused = false, width = 1280 }, run) {
  await start();
  const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: 'reduce' });
  if (refused) await context.addInitScript(() => Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } }));
  const page = await context.newPage();
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  try {
    await run(page);
    assert.deepEqual(failures, [], 'the page threw nothing');
  } finally {
    await context.close();
  }
}

async function open(page) {
  await page.goto(`${origin}/kept-test`);
  await page.waitForFunction(() => window.entryReady, null, { timeout: 30_000 });
  await page.evaluate(() => window.engineReady);
}

// What the page told: each change that cannot land told to the intake, and each failure reported, by its tags.
const said = (page) => page.evaluate(() => ({
  told: window.events.filter((event) => event.name === 'roadmap_write_cannot_land').length,
  reported: window.issues.map(({ operation, tags }) => [operation, tags.code ?? null]),
}));

// Unrelated engine writes, each published to the page, then two frames for React to commit what they changed.
async function unrelatedWrites(page, count) {
  await page.evaluate(async (count) => {
    for (let n = 0; n < count; n++) await window.unrelated(n);
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  }, count);
  await page.waitForTimeout(300);
}

test('with storage refused, each change that cannot land is told once a page load, however often the engine writes, and a new one once', async () => {
  await withContext({ refused: true }, async (page) => {
    await open(page);
    await page.evaluate(() => window.keep([1, 2, 3].map((n) => window.notice(n)).concat([window.notice(4, 'invalid'), window.notice(5, 'Odd code!')])));
    await page.evaluate(() => window.mountHere());
    await page.waitForFunction(() => window.events.length === 3, null, { timeout: 10_000 });
    await unrelatedWrites(page, 10);
    assert.deepEqual(await said(page), { told: 3, reported: [['roadmap-kept-unexpected', 'invalid'], ['roadmap-kept-unexpected', 'other']] },
      'unrelated writes tell nothing again, and a code no refusal spells is reported as other');
    await page.evaluate(() => window.keep([window.notice(6)]));
    await page.waitForFunction(() => window.events.length === 4, null, { timeout: 10_000 });
    await unrelatedWrites(page, 5);
    assert.deepEqual((await said(page)).told, 4, 'a new change is told once');

    await open(page);
    await page.evaluate(() => window.mountHere());
    await page.waitForFunction(() => window.events.length === 4, null, { timeout: 10_000 });
    await unrelatedWrites(page, 5);
    assert.deepEqual(await said(page), { told: 4, reported: [['roadmap-kept-unexpected', 'invalid'], ['roadmap-kept-unexpected', 'other']] },
      'a browser that keeps nothing tells each change again once on the next page load, and no more');
  });
});

test('with storage kept, more than two hundred changes are each told once on this browser: unrelated writes and reloads tell none', async () => {
  await withContext({}, async (page) => {
    await open(page);
    await page.evaluate(() => window.keep(Array.from({ length: 250 }, (_, n) => window.notice(n + 1)).concat([window.notice(900, 'invalid')])));
    await page.evaluate(() => window.mountHere());
    await page.waitForFunction(() => window.events.length === 250, null, { timeout: 10_000 });
    await unrelatedWrites(page, 5);
    assert.deepEqual({ said: await said(page), stored: await page.evaluate(() => JSON.parse(localStorage.getItem('windmill:roadmap:kept-told')).length) },
      { said: { told: 250, reported: [['roadmap-kept-unexpected', 'invalid']] }, stored: 251 }, 'each notice is told once and its id kept, past two hundred');

    await open(page);
    await page.evaluate(() => window.mountHere());
    await unrelatedWrites(page, 5);
    assert.deepEqual(await said(page), { told: 0, reported: [] }, 'a reload tells nothing again');
    await page.evaluate(() => window.keep([window.notice(251)]));
    await page.waitForFunction(() => window.events.length === 1, null, { timeout: 10_000 });

    await open(page);
    await page.evaluate(() => window.mountHere());
    await unrelatedWrites(page, 5);
    assert.deepEqual({ said: await said(page), stored: await page.evaluate(() => JSON.parse(localStorage.getItem('windmill:roadmap:kept-told')).length) },
      { said: { told: 0, reported: [] }, stored: 252 }, 'the new change, told on the page before, is not told again');
  });
});

for (const [answer, reported, discarded] of [['not held', [], []], ['throws', [['roadmap-kept-discard', null]], []]]) {
  test(`a kept change's Discard the engine answers ${answer === 'not held' ? 'with a notice it no longer holds closes the change quietly' : 'by throwing reports once, under the list\'s own name, and keeps the change'}`, async () => {
    await withContext({ width: 390 }, async (page) => {
      await open(page);
      await page.evaluate(() => window.keep([window.notice(1)]));
      await page.evaluate((answer) => window.mountList(answer === 'not held' ? async () => false : async () => { throw new Error('the store did not commit'); }), answer);
      await page.locator('.st-kept-row').click();
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Discard', exact: true }).click();
      if (answer === 'not held') await page.locator('.st-kept-count').waitFor({ timeout: 10_000 });
      else await page.locator('.st-kept-page:not(.st-kept-page--ask) .st-kept-discard').waitFor({ timeout: 10_000 });
      assert.deepEqual({
        reported: (await said(page)).reported,
        discarded: await page.evaluate(() => window.events.filter((event) => event.name === 'roadmap_kept' && event.props.step === 'discard')),
      }, { reported, discarded });
    });
  });
}
