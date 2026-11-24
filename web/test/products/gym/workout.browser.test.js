import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { GymProduct } from '../../../../packages/api-contract/sync/reference/gym/product.js';
import { hello } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { registry } from '../../../src/platform/sync/schema.js';
import { SeedExercises } from '../../../src/products/gym/domain/seedExercises.js';
import { beacon, withBrowserErrors } from '../roadmap/browserFixture.js';

// A workout on the web (web-device-parity §4): the real account provider and shell over the browser's own engine, its
// copy seeded with the fixture's routine (Upper A) by an earlier visit, and every `/v1` request the test's to answer or to
// hold. Two pages of one context are two tabs of one browser. `WM_WORKOUT_SHOTS` names a folder for the logging page's
// screenshots at 1440 and 390.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import AuthProvider from '/src/shell/auth/AuthProvider.jsx';
import { SignInDoorProvider } from '/src/shell/auth/SignInDoor.jsx';
import { Shell } from '/src/shell/chrome/Shell.jsx';
import { BrowserSyncEngine } from '/src/platform/sync/engine.js';
import { registry } from '/src/platform/sync/schema.js';
import { syncSession } from '/src/platform/sync/session.js';
import '/src/styles/global.css';

window.seed = async ({ response, rows }) => {
  const timing = { send: { wall: Date.now(), mono: 0, boot: 'seed' }, recv: { wall: Date.now(), mono: 0, boot: 'seed' } };
  const engine = await BrowserSyncEngine.open({ registry, document: null, window: null,
    navigator: { onLine: false, locks: navigator.locks, storage: navigator.storage },
    transport: { request: async () => ({ response, timing }) }, telemetry: { failure() {}, event() {} } });
  await engine.signIn('A');
  await engine.write(null, (device) => {
    rows.forEach((row, index) => device.activeReplica.putConfirmed('self/gym', { ...row, seq: index + 1 }));
    device.activeReplica.cursors['self/gym'] = { ...device.activeReplica.cursorOf('self/gym'), booted: true };
  }, ['self/gym']);
  engine.close();
};
window.drawnSets = () => syncSession.engine.observe('self/gym').getSnapshot().drawn.filter((record) => record.t === 'set' && record.life?.[0] !== 'dead');
// The room follows the address as the app's navigation does: a screen that moves sets the hash.
function Room() {
  const [hash, setHash] = React.useState(window.location.hash);
  React.useEffect(() => {
    const moved = () => setHash(window.location.hash);
    window.addEventListener('hashchange', moved);
    return () => window.removeEventListener('hashchange', moved);
  }, []);
  return React.createElement(Shell, { location: { pathname: '/app/gym', hash, search: '' } });
}
window.mount = () => {
  createRoot(document.getElementById('root')).render(React.createElement(AuthProvider, null,
    React.createElement(SignInDoorProvider, null, React.createElement(Room))));
};
window.entryReady = true;
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-gym-live-test`,
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('') },
    plugins: [{ name: 'gym-live-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/gym-live-entry.js') return '\0gym-live-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0gym-live-events';
        if (id.endsWith('/telemetry/sentry.js')) return '\0gym-live-issues';
      },
      load(id) {
        if (id === '\0gym-live-entry') return entry;
        if (id === '\0gym-live-events') return beacon;
        if (id === '\0gym-live-issues') return 'export function captureError(product, operation) { (window.issues ??= []).push(operation); }';
      },
      configureServer(vite) {
        vite.middlewares.use('/gym-live', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Windmill</title><link rel="icon" href="/favicon.svg" type="image/svg+xml" /><div id="root"></div><script type="module" src="/gym-live-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client', 'react-dom', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => {
  try { await ready; } finally { await browser?.close(); await server?.close(); }
});

const stamp = '1:0:srv';
const entries = [
  { exerciseId: 'back-squat', sets: [{ reps: 5, weightKg: 100 }, { reps: 5, weightKg: 100 }], restSeconds: 180 },
  { exerciseId: 'dumbbell-bench-press', sets: [{ reps: 8, weightKg: 16 }, { reps: 8, weightKg: 16 }, { reps: 8, weightKg: 16 }], restSeconds: 120 },
  { exerciseId: 'pull-up', sets: [{ reps: 8, weightKg: 10 }, { reps: 8, weightKg: 10 }, { reps: 8, weightKg: 10 }], restSeconds: 120 },
];

// A browser whose copy holds Upper A, signed in as A; `/v1/sync/push` is held unless `pushes` collects it.
async function browserWith(t, { width = 1440, height = 1000, pushes = null, rows = [], colorScheme = 'light' } = {}) {
  await ready;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme });
  context.setDefaultTimeout(20000);
  t.after(() => context.close());
  await context.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/me') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":{"id":"A","name":"Ann"}}' });
    if (path === '/v1/sync/hello') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(hello({ state: ServerState.empty({ epoch: 'gym-live', accounts: { A: { name: 'A' } } }), registry, account: 'A', serverTime: Date.now() }).body) });
    }
    if (path === '/v1/sync/push' && pushes) pushes.push(route.request().postData() ?? '');
    return undefined;
  });
  const first = await context.newPage();
  await first.goto(`${origin}/gym-live#/gym`);
  await first.waitForFunction(() => window.entryReady);
  await first.evaluate((seed) => window.seed(seed), {
    response: hello({ state: ServerState.empty({ epoch: 'gym-live', accounts: { A: { name: 'A' } } }), registry, account: 'A', serverTime: Date.now() }),
    rows: [{ t: 'routine', id: 'routineUpperA', born: stamp, life: ['alive', stamp],
      f: { name: ['Upper A', stamp], position: [0, stamp], entries: [entries, stamp] } }, ...rows],
  });
  await first.close();
  const tab = async (hash = '#/gym') => {
    const page = await context.newPage();
    await page.goto(`${origin}/gym-live${hash}`);
    await page.waitForFunction(() => window.entryReady);
    await page.evaluate((at) => window.mount(at), hash);
    return page;
  };
  return { context, tab };
}

const ledger = (page) => page.locator('.gym-live-row.is-logged .gym-live-reading').allTextContents();
const loggable = (page) => page.locator('.gym-live-rack button[type="submit"]:not([aria-disabled="true"])').waitFor();
const steps = (page, name) => page.evaluate((wanted) => (window.events ?? []).filter((event) => event.name === wanted).map((event) => event.props), name);

test('Chromium: a workout starts from a routine, logs and corrects a set, changes its plan, finishes and is discarded', async (t) => {
  const { tab } = await browserWith(t);
  const page = await tab();
  await withBrowserErrors(page, async () => {
    await page.getByRole('button', { name: 'Start', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Empty workout', exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.locator('.gym-live-movement-title').filter({ hasText: 'Back Squat' }).waitFor();
    assert.equal(await page.locator('#gym-live-title').textContent(), 'Upper A');
    await loggable(page);
    assert.equal(await page.locator('.gym-live-load input').inputValue(), '100');
    await page.getByRole('button', { name: 'Log set', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
    assert.deepEqual(await ledger(page), ['100 × 5']);
    assert.equal(await page.locator('.gym-live-since').count(), 1, 'the rest clock joins once a set lands');

    // Correct it in place: 102.5 × 4.
    await page.locator('.gym-live-row.is-logged button').first().click();
    await page.getByLabel('Load, kg total', { exact: true }).first().fill('102.5');
    await page.getByLabel('Reps', { exact: true }).first().fill('4');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.gym-live-row.is-logged .gym-live-reading')?.textContent === '102.5 × 4');

    // The plan: Pull-up has nothing logged, so its rest changes in Edit sets.
    await page.locator('.gym-live-movement').filter({ hasText: 'Pull Up' }).click();
    await page.locator('.gym-live-movement-title').filter({ hasText: 'Pull Up' }).waitFor();
    await page.getByRole('button', { name: 'Pull Up — change it', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Edit sets', exact: true }).click();
    await page.getByLabel('Set 1 load, kg', { exact: true }).fill('12.5');
    await page.locator('.gym-live-band.is-edit').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.gym-live-edit').waitFor({ state: 'detached' });
    await page.locator('.gym-live-row.is-current .gym-live-reading').filter({ hasText: '12.5 × 8' }).waitFor();
    assert.deepEqual(await steps(page, 'gym_workout_plan_changed'), [{ action: 'retarget', door: 'workout', outcome: 'ok' }]);

    await page.getByRole('button', { name: 'Finish', exact: true }).click();
    await page.locator('#gym-receipt-title').filter({ hasText: 'Well done.' }).waitFor();
    assert.deepEqual(await steps(page, 'gym_session_started'), [{ screen: 'workout', door: 'routine', outcome: 'ok' }]);
    assert.deepEqual(await steps(page, 'gym_set_logged'), [{ screen: 'workout', outcome: 'ok' }]);
    assert.deepEqual(await steps(page, 'gym_session_finished'), [{ screen: 'workout', outcome: 'ok' }]);

    await page.getByRole('button', { name: 'More for this workout', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Discard workout', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.location.hash), '#/gym/log');
    assert.deepEqual(await page.evaluate(() => window.issues ?? []), []);
  });
});

test('Chromium: an empty workout asks for its first movement, and logs what the rack holds', async (t) => {
  const { tab } = await browserWith(t);
  const page = await tab();
  await withBrowserErrors(page, async () => {
    await page.getByRole('button', { name: 'Empty workout', exact: true }).click();
    await page.locator('#gym-live-title').filter({ hasText: 'Workout' }).waitFor();
    await page.getByRole('region', { name: 'Add movement', exact: true }).waitFor();
    await page.getByPlaceholder(/Search/).fill('face pull');
    await page.getByRole('button', { name: /Face Pull/ }).first().click();
    await page.locator('.gym-live-movement-title').filter({ hasText: 'Face Pull' }).waitFor();
    await loggable(page);
    await page.getByRole('button', { name: 'More reps', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.gym-live-reps input')?.value === '6');
    await loggable(page);
    await page.getByRole('button', { name: 'Log set', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
    assert.deepEqual(await ledger(page), ['20 × 6']);
    assert.deepEqual(await steps(page, 'gym_session_started'), [{ screen: 'workout', door: 'empty', outcome: 'ok' }]);
    assert.deepEqual(await steps(page, 'gym_workout_adjusted'), [{ screen: 'workout', field: 'reps', outcome: 'ok' }]);
  });
});

test('Chromium: Log set tapped in two tabs on one offer logs one set', async (t) => {
  const { tab } = await browserWith(t);
  const one = await tab();
  await one.getByRole('button', { name: 'Start', exact: true }).click();
  await loggable(one);
  const two = await tab('#/gym/workout');
  await loggable(two);
  const offers = await Promise.all([one, two].map((page) => page.evaluate(() => document.querySelector('.gym-live-load input').value)));
  assert.deepEqual(offers, ['100', '100']);
  await Promise.all([
    one.getByRole('button', { name: 'Log set', exact: true }).click(),
    two.getByRole('button', { name: 'Log set', exact: true }).click(),
  ]);
  for (const page of [one, two]) await page.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
  await one.waitForTimeout(300);
  assert.equal((await one.evaluate(() => window.drawnSets())).length, 1);
  assert.deepEqual(await ledger(two), ['100 × 5']);
});

test('Chromium: a plan edit another tab made stale is refused, its draft kept, and Save mine writes it', async (t) => {
  const { tab } = await browserWith(t);
  const one = await tab();
  await one.getByRole('button', { name: 'Start', exact: true }).click();
  await loggable(one);
  const two = await tab('#/gym/workout');
  await loggable(two);
  for (const page of [one, two]) {
    await page.locator('.gym-live-movement').filter({ hasText: 'Pull Up' }).click();
    await page.getByRole('button', { name: 'Pull Up — change it', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Edit sets', exact: true }).click();
  }
  await one.getByLabel('Set 1 load, kg', { exact: true }).fill('15');
  await one.locator('.gym-live-band.is-edit').getByRole('button', { name: 'Save', exact: true }).click();
  await one.locator('.gym-live-edit').waitFor({ state: 'detached' });
  await two.getByLabel('Set 1 load, kg', { exact: true }).fill('12.5');
  await two.locator('.gym-live-band.is-edit').getByRole('button', { name: 'Save', exact: true }).click();
  const notice = two.locator('.gym-live-stale');
  await notice.waitFor();
  assert.equal(await notice.locator('h2').textContent(), 'Pull Up changed in another tab.');
  assert.equal(await two.getByLabel('Set 1 load, kg', { exact: true }).inputValue(), '12.5', 'the draft stays as typed');
  assert.deepEqual(await steps(two, 'gym_workout_plan_changed'), [{ action: 'retarget', door: 'workout', outcome: 'refused', code: 'domain', reason: 'stale' }]);
  await two.getByRole('button', { name: 'Save mine', exact: true }).click();
  await two.locator('.gym-live-edit').waitFor({ state: 'detached' });
  await one.locator('.gym-live-row.is-current .gym-live-reading').filter({ hasText: '12.5 × 8' }).waitFor();
});

test('Chromium: a set logged with no connection is kept through a reload and sent when there is one', async (t) => {
  const { context, tab } = await browserWith(t);
  const page = await tab();
  await page.getByRole('button', { name: 'Empty workout', exact: true }).click();
  await page.getByPlaceholder(/Search/).fill('back squat');
  await page.getByRole('button', { name: /Back Squat/ }).first().click();
  await loggable(page);
  await page.getByRole('button', { name: 'Log set', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
  const [set] = await page.evaluate(() => window.drawnSets().map((record) => record.id));
  await page.close();

  // The connection returns: the reference server takes what the browser kept.
  const product = new GymProduct();
  product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  let state = ServerState.empty({ epoch: 'gym-live', accounts: { A: { name: 'A' } } });
  const taken = [];
  await context.route('**/v1/sync/push', (route) => {
    const request = JSON.parse(route.request().postData() ?? '{}');
    const out = push({ state, registry, product, account: 'A', request, serverNow: Date.now() });
    state = out.state;
    taken.push(JSON.stringify(request));
    return route.fulfill({ status: out.response.status, contentType: 'application/json', body: JSON.stringify(out.response.body) });
  });
  const again = await tab('#/gym/workout');
  await again.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
  assert.deepEqual(await ledger(again), ['20 × 5']);
  const deadline = Date.now() + 15000;
  while (!taken.some((body) => body.includes(set)) && Date.now() < deadline) await again.waitForTimeout(200);
  assert.ok(taken.some((body) => body.includes(set)), 'the set the reload kept went out once the connection returned');
});

test('Chromium: the tab’s title and favicon follow the rest clock, hidden and back', async (t) => {
  // A routine of one movement that rests 15 s, so the rest crosses its target with the page shown.
  const { tab } = await browserWith(t, { rows: [{ t: 'routine', id: 'routineQuick', born: stamp, life: ['alive', stamp],
    f: { name: ['Quick', stamp], position: [1, stamp], entries: [[{ exerciseId: 'face-pull', sets: [{ reps: 15, weightKg: 15 }, { reps: 15, weightKg: 15 }], restSeconds: 15 }], stamp] } }] });
  const page = await tab();
  const icon = () => page.evaluate(() => document.querySelector('link[rel="icon"]').getAttribute('href'));
  await page.locator('.gym-routine').filter({ hasText: 'Quick' }).getByRole('button', { name: 'Start', exact: true }).click();
  await loggable(page);
  await page.waitForFunction(() => /^\d+:\d\d · Quick$/.test(document.title));
  assert.equal(await icon(), '/favicon-workout.svg');
  await page.getByRole('button', { name: 'Log set', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
  await page.waitForFunction(() => /^0:0\d · Quick$/.test(document.title));

  await page.getByRole('link', { name: 'Routines', exact: true }).first().click();
  await page.locator('.gym-live-bar').waitFor();
  assert.equal(await page.locator('.gym-live-bar-name').textContent(), 'Quick');
  assert.equal(await page.getByRole('button', { name: 'Start', exact: true }).count(), 0, 'no start beside the open workout');
  await page.locator('.gym-live-bar').click();
  await page.locator('.gym-live-movement-title').filter({ hasText: 'Face Pull' }).waitFor();
  await page.locator('.gym-live-clocks.is-reached').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('link[rel="icon"]').getAttribute('href') === '/favicon-rest.svg');
  assert.match(await page.title(), /^0:[1-5]\d · Quick$/);
  assert.deepEqual(await steps(page, 'gym_hidden_workout'), [{ action: 'hide' }, { action: 'open', door: 'bar' }]);
  assert.deepEqual(await steps(page, 'gym_rest_target_reached'), [{ screen: 'workout' }]);
});

test('Chromium: the logging page at 1440 and 390, for the boards', { skip: !process.env.WM_WORKOUT_SHOTS }, async (t) => {
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    const { tab } = await browserWith(t, { width, height, colorScheme: 'dark' });
    const page = await tab();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await loggable(page);
    await page.getByRole('button', { name: 'Dumbbell Bench Press, 2 of 3', exact: true }).click();
    await page.locator('.gym-live-movement-title').filter({ hasText: 'Dumbbell Bench Press' }).waitFor();
    for (let set = 0; set < 2; set += 1) {
      await loggable(page);
      await page.getByRole('button', { name: 'Log set', exact: true }).click();
      await page.waitForFunction((count) => document.querySelectorAll('.gym-live-row.is-logged').length === count, set + 1);
    }
    await page.mouse.click(5, height / 2);
    await page.waitForTimeout(1300);
    await page.screenshot({ path: `${process.env.WM_WORKOUT_SHOTS}/wd2-logging-${width}.png` });
  }
});
