import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { hello } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { registry } from '../../../src/platform/sync/schema.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const now = 1_800_000_000_000;
const response = hello({ state: ServerState.empty({ epoch: 'plan-recovery', accounts: { A: { name: 'A' } } }),
  registry, account: 'A', serverTime: now });
const vectors = JSON.parse(readFileSync(new URL('../../../../packages/api-contract/gym/domain/routines-actions.json', import.meta.url), 'utf8'))
  .filter((vector) => vector.input.read === 'SessionPlan' && vector.expect.decodeError);
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserSyncEngine } from '/src/platform/sync/engine.js';
import { registry } from '/src/platform/sync/schema.js';
import { syncSession } from '/src/platform/sync/session.js';
import { ErrorBoundary } from '/src/design-system/feedback/ErrorBoundary.jsx';
import { useTrainingLog } from '/src/products/gym/useTrainingLog.js';
import { Notes } from '/src/products/gym/notes/Notes.jsx';
import { RoutinesList } from '/src/products/gym/Routines.jsx';
import { LogList } from '/src/products/gym/Log.jsx';

window.openRoom = async ({ response, now, plan, seed }) => {
  const timing = { send: { wall: now, mono: now, boot: 'plan' }, recv: { wall: now, mono: now, boot: 'plan' } };
  window.engine = await BrowserSyncEngine.open({ name: 'plan-recovery', registry,
    now: () => now, monotonic: () => now, document: null, window: null,
    navigator: { onLine: false, locks: navigator.locks, storage: navigator.storage },
    transport: { request: async () => ({ response, timing }) }, telemetry: { failure() {}, event() {} } });
  if (seed) {
    await engine.signIn('A');
    await engine.write(null, (device) => {
      const stamp = '1:0:srv';
      const records = [
        ['note', 'note_private', { title: 'Private note', body: 'Private body', ord: 'a0' }],
        ['routine', 'routine_private', { name: 'Private routine', position: 0, entries: [{ exerciseId: 'bench-press' }] }],
        ['session', 'session_private', { startedAt: now - 3600000, finishedAt: now - 1000, plan }],
        ['set', 'set_private', { sessionId: 'session_private', exerciseId: 'bench-press', weightKg: 60,
          reps: 8, kind: 'working', note: 'Private set', completedAt: now - 2000 }],
      ];
      for (const [index, [t, id, fields]] of records.entries()) device.activeReplica.putConfirmed('self/gym', {
        t, id, seq: index + 1, born: stamp, life: ['alive', stamp],
        f: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, [value, stamp]])),
        ...(t === 'set' ? { v: { setNumber: 1 } } : {}),
      });
      device.activeReplica.cursors['self/gym'] = { ...device.activeReplica.cursorOf('self/gym'), booted: true };
    }, ['self/gym']);
  }
  engine.observe('self/gym');
  await engine.start();
  syncSession.publish({ engine, ready: true, signedIn: true, online: false, error: false });
  function Room() {
    const log = useTrainingLog();
    const [screen, setScreen] = React.useState('Notes');
    return React.createElement(React.Fragment, null,
      React.createElement('nav', null, ...['Notes', 'Routines', 'Log'].map((name) =>
        React.createElement('button', { key: name, onClick: () => setScreen(name) }, name + ' tab'))),
      screen === 'Notes' ? React.createElement(Notes, { log })
        : screen === 'Routines' ? React.createElement(RoutinesList, { log })
        : React.createElement(LogList, { log, sessionId: 'session_private' }));
  }
  window.reactRoot = createRoot(document.getElementById('root'));
  reactRoot.render(React.createElement(ErrorBoundary, null, React.createElement(Room)));
};
window.entryReady = true;
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-plan-test`,
    define: { 'import.meta.env.VITE_SENTRY_DSN': JSON.stringify('https://abcd@sentry.invalid/23') },
    plugins: [{ name: 'plan-test',
      resolveId(id) { if (id === '/plan-entry.js') return '\0plan-entry'; },
      load(id) { if (id === '\0plan-entry') return entry; },
      configureServer(server) {
        server.middlewares.use('/plan-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Plan recovery test</title><div id="root"></div><script type="module" src="/plan-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => {
  try { await ready; } finally { await browser?.close(); await server?.close(); }
});

for (const vector of vectors) test(`Chromium: ${vector.name} keeps Gym usable across reload and reports only gym-projection`, async () => {
  await ready;
  const context = await browser.newContext({ timezoneId: 'UTC' });
  context.setDefaultTimeout(8000);
  const errors = [], reports = [];
  await context.route('https://sentry.invalid/**', async (route) => {
    reports.push(JSON.parse(route.request().postData().split('\n')[2]));
    await route.fulfill({ status: 200, body: '{}' });
  });
  try {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.clock.setFixedTime(new Date(now));
    await page.goto(`${origin}/plan-test`);
    for (const seed of [true, false]) {
      if (!seed) await page.reload();
      await page.waitForFunction(() => window.entryReady);
      await page.evaluate((options) => openRoom(options), { response, now, plan: vector.input.input.plan, seed });
      await page.locator('.gym-notes, [role="alert"]').waitFor();
      assert.equal(await page.getByRole('alert').count(), 0, 'a rejected plan must not reach the render error boundary');
      assert.deepEqual(await page.locator('.gym-note-title').allTextContents(), ['Private note']);
      await page.getByRole('button', { name: 'Routines tab', exact: true }).click();
      await page.locator('.gym-routine-name').waitFor();
      assert.deepEqual(await page.locator('.gym-routine-name').allTextContents(), ['Private routine']);
      await page.getByRole('button', { name: 'Log tab', exact: true }).click();
      await page.locator('.gym-reader-totals').waitFor();
      assert.deepEqual(await page.locator('.gym-reader-totals dd').allTextContents(), ['1', '8', '480']);
      assert.equal(await page.locator('.gym-detail-plan').count(), 0, 'the malformed plan is not drawn as a valid plan');
      assert.deepEqual(await page.evaluate(() => ({
        plan: engine.observe('self/gym').getSnapshot().stored.find((row) => row.id === 'session_private').f.plan[0],
        pending: engine.device.activeReplica.entries().length,
      })), { plan: vector.input.input.plan, pending: 0 }, 'the original persisted plan is preserved without a repair write');
      await page.getByRole('button', { name: 'Notes tab', exact: true }).click();
      await page.locator('.gym-notes').waitFor();
      await page.evaluate(() => { reactRoot.unmount(); engine.close(); });
    }
    assert.deepEqual(errors, []);
    assert.equal(reports.length, 2, 'each page load reports its schema fault once');
    for (const report of reports) {
      assert.deepEqual(report.exception.values, [{ type: 'gym', value: 'gym-projection', stacktrace: { frames: [] } }]);
      assert.deepEqual(report.request, { url: '/gym' });
      assert.doesNotMatch(JSON.stringify(report), /Private|session_private|routine_private|note_private|set_private|DecodeError|not an? (string|object|array)/);
    }
  } finally { await context.close(); }
});
