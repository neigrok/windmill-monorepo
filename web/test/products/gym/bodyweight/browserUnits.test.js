import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { hello } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { ServerState } from '../../../../../packages/api-contract/sync/reference/server/state.js';
import { registry } from '../../../../src/platform/sync/schema.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const now = Date.parse('2027-01-15T12:00:00Z');
const response = hello({ state: ServerState.empty({ epoch: 'bodyweight-units', accounts: { A: { name: 'A' } } }),
  registry, account: 'A', serverTime: now });
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserSyncEngine } from '/src/platform/sync/engine.js';
import { registry } from '/src/platform/sync/schema.js';
import { syncSession } from '/src/platform/sync/session.js';
import { useTrainingLog } from '/src/products/gym/useTrainingLog.js';
import { BodyweightScreen } from '/src/products/gym/bodyweight/Bodyweight.jsx';
import { GymSettingsSection } from '/src/products/gym/settings/GymSettingsSection.jsx';

window.openRoom = async ({ response, now, seed, settings }) => {
  const timing = { send: { wall: now, mono: now, boot: 'units' }, recv: { wall: now, mono: now, boot: 'units' } };
  window.engine = await BrowserSyncEngine.open({ name: 'bodyweight-units', registry,
    now: () => now, monotonic: () => now, document: null, window: null,
    navigator: { onLine: false, locks: navigator.locks, storage: navigator.storage },
    transport: { request: async () => ({ response, timing }) },
    telemetry: { failure() {}, event() {} } });
  if (seed) {
    await engine.signIn('A');
    await engine.write(null, (device) => {
      const stamp = '1:0:srv';
      device.activeReplica.putConfirmed('self/gym', { t: 'prefs', id: 'prefs', seq: 1, f: { units: ['kg', stamp] } });
      device.activeReplica.putConfirmed('self/gym', { t: 'weighin', id: '2027-01-15', seq: 2,
        life: ['alive', stamp], born: stamp, f: { kg: [80, stamp], recordedAt: [now, stamp] } });
      device.activeReplica.cursors['self/gym'] = { ...device.activeReplica.cursorOf('self/gym'), booted: true };
    }, ['self/gym']);
  }
  engine.observe('self/gym');
  await engine.start();
  syncSession.publish({ engine, ready: true, signedIn: true, online: false, error: false });
  function Room() { return React.createElement(BodyweightScreen, { log: useTrainingLog() }); }
  window.reactRoot = createRoot(document.getElementById('root'));
  reactRoot.render(React.createElement(settings ? GymSettingsSection : Room));
};
window.incomingUnits = (units) => engine.write(null, (device) => {
  device.activeReplica.putConfirmed('self/gym', { t: 'prefs', id: 'prefs', seq: 3, f: { units: [units, '2:0:srv'] } });
}, ['self/gym']);
window.entryReady = true;
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-bodyweight-units-test`,
    plugins: [{ name: 'bodyweight-units-test',
      resolveId(id) { if (id === '/bodyweight-units-entry.js') return '\0bodyweight-units-entry'; },
      load(id) { if (id === '\0bodyweight-units-entry') return entry; },
      configureServer(server) {
        server.middlewares.use('/bodyweight-units-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Bodyweight units test</title><div id="root"></div><script type="module" src="/bodyweight-units-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client', '@noble/hashes/sha256', '@noble/hashes/utils'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => {
  try { await ready; } finally { await browser?.close(); await server?.close(); }
});

async function open(context, errors, { seed = true, settings = false } = {}) {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.setFixedTime(new Date(now));
  await page.goto(`${origin}/bodyweight-units-test`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate((options) => openRoom(options), { response, now, seed, settings });
  if (settings) await page.getByRole('group', { name: 'Weight units' }).waitFor();
  else {
    await page.getByRole('button', { name: '80 kg · 15 Jan', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Bodyweight in kg', exact: true }).inputValue(), '80');
  }
  return page;
}

async function assertPounds(page) {
  await page.waitForFunction(() => {
    const field = document.querySelector('.gym-weigh-input');
    return field?.getAttribute('aria-label') === 'Bodyweight in lb' && field.value === '176.4'
      && !!document.querySelector('[role="button"][aria-label="176.4 lb · 15 Jan"]');
  }, undefined, { timeout: 3000 }).catch((error) => { if (error.name !== 'TimeoutError') throw error; });
  assert.deepEqual(await page.evaluate(() => ({
    dots: [...document.querySelectorAll('.gym-bodyweight-chart [role="button"][aria-label]')].map((dot) => dot.getAttribute('aria-label')),
    field: document.querySelector('.gym-weigh-input')?.getAttribute('aria-label'),
    value: document.querySelector('.gym-weigh-input')?.value,
    unit: document.querySelector('.gym-weigh-unit')?.textContent,
  })), { dots: ['176.4 lb · 15 Jan'], field: 'Bodyweight in lb', value: '176.4', unit: 'lb' });
}

test('Chromium: incoming units update the bodyweight chart and open correction field together', async () => {
  await ready;
  const context = await browser.newContext({ timezoneId: 'UTC' });
  const errors = [];
  try {
    const page = await open(context, errors);
    await page.evaluate(() => incomingUnits('lb'));
    await assertPounds(page);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Chromium: offline settings in another tab update the chart and open correction field live', async () => {
  await ready;
  const context = await browser.newContext({ timezoneId: 'UTC' });
  const errors = [];
  try {
    const chart = await open(context, errors);
    const settings = await open(context, errors, { seed: false, settings: true });
    await context.setOffline(true);
    await settings.getByRole('button', { name: 'lb', exact: true }).click();
    await chart.waitForFunction(() => engine.observe('self/gym').getSnapshot().drawn
      .find((row) => row.t === 'prefs').f.units[0] === 'lb');
    assert.deepEqual(await Promise.all([chart, settings].map((page) => page.evaluate(() => ({
      browserOnline: navigator.onLine, engineOnline: engine.online,
    })))), [{ browserOnline: false, engineOnline: false }, { browserOnline: false, engineOnline: false }]);
    await assertPounds(chart);
    assert.equal(await settings.getByRole('button', { name: 'lb', exact: true }).getAttribute('aria-pressed'), 'true');
    await chart.getByRole('textbox', { name: 'Bodyweight in lb', exact: true }).fill('200');
    await chart.getByRole('button', { name: 'Save', exact: true }).click();
    await chart.getByRole('dialog', { name: 'Weigh in', exact: true }).waitFor({ state: 'hidden' });
    assert.deepEqual(await chart.evaluate(() => engine.observe('self/gym').getSnapshot().drawn
      .filter((row) => row.t === 'weighin').map((row) => ({ id: row.id, kg: row.f.kg[0] }))),
    [{ id: '2027-01-15', kg: 90.72 }]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
