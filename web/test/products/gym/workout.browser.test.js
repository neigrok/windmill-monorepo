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
import { Fields } from '../../../src/platform/domain-kit/entities.js';
import { RoutineChange } from '../../../src/products/gym/domain/proposals.js';
import { RoutineEntry } from '../../../src/products/gym/domain/routines.js';
import { SeedExercises } from '../../../src/products/gym/domain/seedExercises.js';
import { beacon, withBrowserErrors } from '../roadmap/browserFixture.js';

// A workout on the web (web-device-parity §4): the real account provider and shell over the browser's own engine, its
// copy seeded with the fixture's routine (Upper A) by an earlier visit, and every `/v1` request the test's to answer or to
// hold. Two pages of one context are two tabs of one browser. Coach's AI service is played (`window.aiRounds`): each round
// answers the next, a call to one of Coach's abilities or words. The page loads the app's fonts, so a screenshot judges its
// type; `WM_WORKOUT_SHOTS` names a folder for the logging page's and Coach's screenshots at 1440 and 390.
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
import '/src/styles/fonts.js';
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
window.openWorkout = () => syncSession.engine.observe('self/gym').getSnapshot().drawn.find((record) => record.t === 'session' && !record.f?.finishedAt?.[0])?.id ?? null;
window.engineOpen = () => Boolean(syncSession.engine);
// This tab's engine writes wait until releaseCommits(), so a test can order two tabs' writes.
window.holdCommits = () => {
  const engine = syncSession.engine;
  const commit = engine.commit;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  engine.commit = async (...args) => { await held; return commit.apply(engine, args); };
  window.releaseCommits = () => { engine.commit = commit; release(); };
};
// This tab's next \`count\` rack settles, a write of device rows alone that names an offer, throw as a bug would.
window.failSettles = (count) => {
  const engine = syncSession.engine;
  const commit = engine.commit.bind(engine);
  engine.commit = (scope, body, ...rest) => commit(scope, typeof body !== 'function' ? body : (views) => {
    const decided = body(views);
    const gesture = decided?.gesture;
    const settles = gesture && gesture.changes.length === 0 && Object.keys(gesture.opts?.local ?? {}).some((key) => key.startsWith('offer:'));
    if (settles && count > 0) { count -= 1; throw new Error('the settle broke'); }
    return decided;
  }, ...rest);
};
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

// The AI service Coach's turns call, played: each round is the next of `window.aiRounds`, calls to Coach's abilities
// (`{ calls: [{ name, input }] }`) or its words (`{ text }`), and the allowance is open.
const playedAi = `
const allowance = { tier: 'free', period: 'calendar_month_utc', limit: '1', used: '0', reserved: '0', remaining: '1', resetsAt: null,
  budgetResetsAt: null, code: 'ok', capabilities: { text: { large: 'large', medium: 'medium', small: 'small' }, transcription: false } };
const ended = (stop, parts) => ({ id: 9, event: 'ended', data: { stop, message: { role: 'assistant', parts, carry: 'c' }, charged: '0', allowance: null } });
let calls = 0;
export class AiClient {
  connected() { return true; }
  clearPass() {}
  async allowance() { return allowance; }
  async text({ onText }) {
    const round = (window.aiRounds ?? []).shift();
    if (!round) throw new Error('no round left to play');
    if (round.calls) return ended('tool_calls', round.calls.map((call) => ({ toolCall: { id: 'toolu_' + (calls += 1), name: call.name, input: call.input } })));
    await onText?.(round.text);
    return ended('completed', [{ text: round.text }]);
  }
  async result() { throw new Error('no result to play'); }
}
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
        if (id.endsWith('/platform/ai/client.js')) return '\0gym-live-ai';
      },
      load(id) {
        if (id === '\0gym-live-entry') return entry;
        if (id === '\0gym-live-events') return beacon;
        if (id === '\0gym-live-issues') return 'export function captureError(product, operation) { (window.issues ??= []).push(operation); }';
        if (id === '\0gym-live-ai') return playedAi;
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
const engineOpen = (page) => page.waitForFunction(() => window.engineOpen());
const said = (page) => page.locator('.gym-toast-slot').textContent();

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
    assert.deepEqual(await steps(page, 'gym_workout_movement_chosen'), [{ screen: 'workout', outcome: 'ok' }]);
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
    // What the field shows is what Log set logs, typed and not yet let go.
    await page.locator('.gym-live-load input').fill('22.5');
    await page.getByRole('button', { name: 'Log set', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
    assert.deepEqual(await ledger(page), ['22.5 × 6']);
    assert.deepEqual(await steps(page, 'gym_session_started'), [{ screen: 'workout', door: 'empty', outcome: 'ok' }]);
    assert.deepEqual(await steps(page, 'gym_workout_adjusted'), [{ screen: 'workout', field: 'reps', outcome: 'ok' }]);
  });
});

// Tab one's write waits until tab two's has landed, so both taps are on the one offer and tab one's comes second: it finds
// the set written and writes, tells and says nothing.
test('Chromium: Log set tapped in two tabs on one offer logs one set, and the second tap is quiet', async (t) => {
  const { tab } = await browserWith(t);
  const one = await tab();
  await one.getByRole('button', { name: 'Start', exact: true }).click();
  await loggable(one);
  const two = await tab('#/gym/workout');
  await loggable(two);
  const offers = await Promise.all([one, two].map((page) => page.evaluate(() => document.querySelector('.gym-live-load input').value)));
  assert.deepEqual(offers, ['100', '100']);
  await one.evaluate(() => window.holdCommits());
  await one.getByRole('button', { name: 'Log set', exact: true }).click();
  await two.getByRole('button', { name: 'Log set', exact: true }).click();
  await two.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
  await one.evaluate(() => window.releaseCommits());
  await one.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
  await one.locator('.gym-live-rack button[type="submit"]:not([aria-busy="true"])').waitFor();
  await one.waitForTimeout(300);
  assert.equal((await one.evaluate(() => window.drawnSets())).length, 1);
  assert.deepEqual(await ledger(two), ['100 × 5']);
  assert.deepEqual({ one: await steps(one, 'gym_set_logged'), two: await steps(two, 'gym_set_logged') },
    { one: [], two: [{ screen: 'workout', outcome: 'ok' }] });
  assert.equal(await said(one), '', 'the second tap says nothing');
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
  assert.deepEqual(await two.locator('.gym-live-edit').getByRole('button').allTextContents(), ['×', '×', '×', '2:00▾', 'Use latest', 'Save mine'],
    'while the answer stands, Add set, Swap and Remove wait');
  assert.equal(await two.locator('.gym-live-edit-save').isDisabled(), true);
  assert.deepEqual(await steps(two, 'gym_workout_plan_changed'), [{ action: 'retarget', door: 'workout', outcome: 'refused', code: 'domain', reason: 'stale' }]);
  await two.getByRole('button', { name: 'Save mine', exact: true }).click();
  await two.locator('.gym-live-edit').waitFor({ state: 'detached' });
  await one.locator('.gym-live-row.is-current .gym-live-reading').filter({ hasText: '12.5 × 8' }).waitFor();
});

test('Chromium: a set logged with no connection is kept through a reload and sent when there is one', async (t) => {
  const { context, tab } = await browserWith(t);
  await context.route('**/v1/sync/push', (route) => route.abort('internetdisconnected'));
  const page = await tab();
  await page.getByRole('button', { name: 'Empty workout', exact: true }).click();
  await page.getByPlaceholder(/Search/).fill('back squat');
  await page.getByRole('button', { name: /Back Squat/ }).first().click();
  await loggable(page);
  await page.getByRole('button', { name: 'Log set', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
  const [set] = await page.evaluate(() => window.drawnSets().map((record) => record.id));
  await page.close();

  // Still no connection: a fresh page draws the set from the copy alone.
  const again = await tab('#/gym/workout');
  await again.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
  assert.deepEqual(await ledger(again), ['20 × 5']);

  // The connection returns: the reference server, which knows the seed movements, takes what the browser kept.
  let state = ServerState.empty({ epoch: 'gym-live', accounts: { A: { name: 'A' } } });
  state.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  const answered = [];
  await context.unroute('**/v1/sync/push');
  await context.route('**/v1/sync/push', (route) => {
    const request = JSON.parse(route.request().postData() ?? '{}');
    const out = push({ state, registry, product: new GymProduct(), account: 'A', request, serverNow: Date.now() });
    state = out.state;
    const intent = (request.intents ?? []).find((each) => JSON.stringify(each).includes(set));
    if (intent) answered.push(out.response.body.results?.find((result) => result.n === intent.n) ?? null);
    return route.fulfill({ status: out.response.status, contentType: 'application/json', body: JSON.stringify(out.response.body) });
  });
  await again.evaluate(() => window.dispatchEvent(new Event('online')));
  const deadline = Date.now() + 30000;
  while (answered.length === 0 && Date.now() < deadline) await again.waitForTimeout(200);
  assert.equal(answered[0]?.s, 'ok', 'the server took the set the reload kept');
  await again.waitForTimeout(500);
  assert.deepEqual(await ledger(again), ['20 × 5'], 'the tab draws the set once the server has answered');
  assert.deepEqual(await again.evaluate(() => window.drawnSets().map((record) => record.id)), [set]);
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

test('Chromium: Enter in the load or the reps lands the value and lets the field go, and only Log set logs', async (t) => {
  const { tab } = await browserWith(t);
  const page = await tab();
  await withBrowserErrors(page, async () => {
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await loggable(page);
    const load = page.locator('.gym-live-load input');
    await load.fill('102.5');
    await load.press('Enter');
    await page.waitForFunction(() => document.activeElement?.closest('.gym-live-rack') === null);
    await page.waitForFunction(() => document.querySelector('.gym-live-load input')?.value === '102.5');
    const reps = page.locator('.gym-live-reps input');
    await reps.fill('4');
    await reps.press('Enter');
    await page.waitForFunction(() => document.querySelector('.gym-live-reps input')?.value === '4' && document.activeElement?.closest('.gym-live-rack') === null);
    await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(() => window.drawnSets()), [], 'Enter logs nothing');
    assert.deepEqual(await steps(page, 'gym_workout_adjusted'), [{ screen: 'workout', field: 'weight', outcome: 'ok' }, { screen: 'workout', field: 'reps', outcome: 'ok' }]);
    await loggable(page);
    await page.getByRole('button', { name: 'Log set', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
    assert.deepEqual(await ledger(page), ['102.5 × 4']);
  });
});

// Tab one's step waits until tab two's has landed, so the two steps cross: each is taken from the rack as it is written.
test('Chromium: a step of the ladder and of the reps in each of two tabs at once both count', async (t) => {
  const { tab } = await browserWith(t);
  const one = await tab();
  await one.getByRole('button', { name: 'Start', exact: true }).click();
  await loggable(one);
  const two = await tab('#/gym/workout');
  await loggable(two);
  await one.evaluate(() => window.holdCommits());
  await one.getByRole('button', { name: '+2.5 kg total', exact: true }).click();
  await one.getByRole('button', { name: 'More reps', exact: true }).click();
  await two.getByRole('button', { name: '+2.5 kg total', exact: true }).click();
  await two.waitForFunction(() => document.querySelector('.gym-live-load input')?.value === '102.5');
  await two.getByRole('button', { name: 'More reps', exact: true }).click();
  await two.waitForFunction(() => document.querySelector('.gym-live-reps input')?.value === '6');
  await one.evaluate(() => window.releaseCommits());
  for (const page of [one, two]) {
    await page.waitForFunction(() => document.querySelector('.gym-live-load input')?.value === '105' && document.querySelector('.gym-live-reps input')?.value === '7');
  }
});

test('Chromium: the rest reaching its target is told and toned once with the workout open in two tabs', async (t) => {
  const { tab } = await browserWith(t, { rows: [{ t: 'routine', id: 'routineQuick', born: stamp, life: ['alive', stamp],
    f: { name: ['Quick', stamp], position: [1, stamp], entries: [[{ exerciseId: 'face-pull', sets: [{ reps: 15, weightKg: 15 }, { reps: 15, weightKg: 15 }], restSeconds: 15 }], stamp] } }] });
  const one = await tab();
  await one.locator('.gym-routine').filter({ hasText: 'Quick' }).getByRole('button', { name: 'Start', exact: true }).click();
  await loggable(one);
  await one.getByRole('button', { name: 'Log set', exact: true }).click();
  await one.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
  const two = await tab('#/gym/workout');
  await two.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
  for (const page of [one, two]) await page.locator('.gym-live-clocks.is-reached').waitFor({ timeout: 30000 });
  await one.waitForTimeout(1500);
  const told = [...await steps(one, 'gym_rest_target_reached'), ...await steps(two, 'gym_rest_target_reached')];
  assert.deepEqual(told, [{ screen: 'workout' }]);
});

test('Chromium: a rack settle that fails is reported, says why Log set waits, and is tried again', async (t) => {
  const { tab } = await browserWith(t);
  const page = await tab();
  await engineOpen(page);
  await page.evaluate(() => window.failSettles(2));
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const waiting = page.locator('.gym-live-rack-waiting');
  await waiting.waitFor();
  assert.equal(await waiting.textContent(), 'Log set is waiting for this browser to set the rack. Trying again…');
  assert.equal(await page.locator('.gym-live-rack button[type="submit"]').getAttribute('aria-disabled'), 'true');
  await loggable(page);
  await waiting.waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.issues ?? []), ['gym-rack-settle', 'gym-rack-settle']);
  await page.getByRole('button', { name: 'Log set', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
});

test('Chromium: Edit sets closes, unchanged, when a set lands on its movement from another tab', async (t) => {
  const { tab } = await browserWith(t);
  const one = await tab();
  await one.getByRole('button', { name: 'Start', exact: true }).click();
  await loggable(one);
  const two = await tab('#/gym/workout');
  await loggable(two);
  await one.locator('.gym-live-movement').filter({ hasText: 'Pull Up' }).click();
  await one.getByRole('button', { name: 'Pull Up — change it', exact: true }).click();
  await one.getByRole('menuitem', { name: 'Edit sets', exact: true }).click();
  await one.getByLabel('Set 1 load, kg', { exact: true }).fill('12.5');
  await two.locator('.gym-live-movement').filter({ hasText: 'Pull Up' }).click();
  await two.locator('.gym-live-movement-title').filter({ hasText: 'Pull Up' }).waitFor();
  await loggable(two);
  await two.getByRole('button', { name: 'Log set', exact: true }).click();
  await one.locator('.gym-live-edit').waitFor({ state: 'detached' });
  assert.equal(await said(one), 'Pull Up has a logged set now. Nothing changed.');
  assert.deepEqual(await steps(one, 'gym_workout_plan_changed'), []);
});

test('Chromium: Pop out’s open is a step, and a window the browser refuses is reported, not thrown', async (t) => {
  const { tab } = await browserWith(t);
  const page = await tab();
  await withBrowserErrors(page, async () => {
    await page.evaluate(() => {
      Object.defineProperty(window, 'documentPictureInPicture', { configurable: true,
        value: { requestWindow: () => Promise.reject(new DOMException('no window', 'NotAllowedError')) } });
    });
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await loggable(page);
    await page.getByRole('button', { name: 'Pop out', exact: true }).click();
    await page.waitForFunction(() => (window.issues ?? []).includes('gym-pop-out'));
    assert.deepEqual(await steps(page, 'gym_workout_popped_out'), [{ screen: 'workout', outcome: 'failed' }]);
    await page.evaluate(() => {
      Object.defineProperty(window, 'documentPictureInPicture', { configurable: true,
        value: { requestWindow: async () => window.open('about:blank', 'gym-pop-out', 'popup,width=320,height=220') } });
    });
    const opened = page.context().waitForEvent('page');
    await page.getByRole('button', { name: 'Pop out', exact: true }).click();
    const pip = await opened;
    await pip.getByRole('button', { name: 'Log set', exact: true }).waitFor();
    assert.deepEqual(await steps(page, 'gym_workout_popped_out'), [{ screen: 'workout', outcome: 'failed' }, { screen: 'workout', outcome: 'ok' }]);
    assert.deepEqual(await page.evaluate(() => window.issues), ['gym-pop-out']);
  });
});

test('Chromium: at a phone’s width the sheets cover the app’s header, take their field’s focus, and Escape or the scrim closes them', async (t) => {
  const { tab } = await browserWith(t, { width: 390, height: 844 });
  const page = await tab();
  await withBrowserErrors(page, async () => {
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await loggable(page);
    await page.getByRole('button', { name: 'Log set', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
    const row = page.locator('.gym-live-row.is-logged button').first();
    await row.click();
    const sheet = page.getByRole('dialog', { name: 'Fix set', exact: true });
    await sheet.waitFor();
    assert.deepEqual(await page.evaluate(() => ({ modal: document.querySelector('dialog.wm-sheet').matches(':modal'),
      header: document.elementFromPoint(200, 26) === document.querySelector('dialog.wm-sheet'),
      focused: document.activeElement?.getAttribute('aria-label') })), { modal: true, header: true, focused: 'Load, kg total' });
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.gym-live-row') !== null), true, 'focus is back on the row');
    await page.getByRole('button', { name: 'This workout', exact: true }).click();
    const index = page.getByRole('dialog', { name: 'This workout', exact: true });
    await index.waitFor();
    await page.mouse.click(200, 30);
    await index.waitFor({ state: 'detached' });
  });
});

// Coach during a workout (WD7). Its change to Upper A's open workout: the belt off the pull-ups and face pulls at the end,
// two suggested changes; and the routine's for next time, face pulls added.
const lighter = [entries[0], entries[1], { ...entries[2], sets: entries[2].sets.map((set) => ({ ...set, weightKg: 0 })) },
  { exerciseId: 'face-pull', sets: [{ reps: 15, weightKg: 15 }, { reps: 15, weightKg: 15 }] }];
const answer = 'Finish your last bench set as planned if it feels fine. For today, take the added weight off pull-ups and add face pulls at the end.';
// Coach answers the next question with a change to the workout open on this browser's copy, and with `routine` the
// routine's change too, then its words.
const proposes = (page, { routine = false } = {}) => page.evaluate(({ plan, nextTime, words }) => {
  const workout = { name: 'propose_workout_change', input: { id: 'coach-names-it', sessionId: window.openWorkout(), entries: plan, summary: '' } };
  const upper = { name: 'propose_routine_change', input: { id: 'coach-names-it', routineId: 'routineUpperA', name: 'Upper A', entries: nextTime, summary: '' } };
  window.aiRounds = [{ calls: nextTime ? [workout, upper] : [workout] }, { text: words }];
}, { plan: lighter, nextTime: routine ? [...entries, lighter[3]] : null, words: answer });
const ask = async (scope, question) => {
  const field = scope.getByRole('textbox', { name: 'Ask about your training', exact: true });
  await field.fill(question);
  await field.press('Enter');
};
const coachSteps = async (page) => ({ opened: await steps(page, 'gym_action'), shown: await steps(page, 'gym_proposal_shown'),
  decided: await steps(page, 'gym_proposal_outcome') });

test('Chromium: at a desk Coach opens in the rail beside the rack, and its change to the workout is applied there (WD7.1, WD7.2)', async (t) => {
  const { tab } = await browserWith(t);
  const page = await tab();
  await withBrowserErrors(page, async () => {
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await loggable(page);
    assert.deepEqual(await page.getByRole('tab').allTextContents(), ['This workout', 'Coach']);
    await page.getByRole('tab', { name: 'Coach', exact: true }).click();
    const coach = page.getByRole('tabpanel', { name: 'Coach', exact: true });
    await proposes(page, { routine: true });
    await ask(coach, 'My shoulder feels off on bench today. Should I change anything?');
    const workout = coach.getByRole('region', { name: 'This workout', exact: true });
    await workout.getByRole('button', { name: 'Apply', exact: true }).waitFor();
    assert.equal(await workout.locator('header').innerText(), 'This workout\n2 suggested changes · now');
    const routine = coach.getByRole('region', { name: 'Upper A', exact: true });
    assert.equal(await routine.locator('header').innerText(), 'Upper A\n1 suggested change · next time');
    assert.deepEqual(await Promise.all([workout, routine].map((card) => card.locator('.gym-coach-proposal-apply').evaluate((apply) => apply.classList.contains('is-quiet')))),
      [false, true], 'this workout\'s card holds the one prominent Apply');
    assert.equal(await page.getByRole('button', { name: 'Log set', exact: true }).isVisible(), true, 'the rack stays beside Coach');

    await workout.getByRole('button', { name: 'Apply', exact: true }).click();
    await coach.getByText('Applied · this workout', { exact: true }).waitFor();
    assert.equal(await routine.getByRole('button', { name: 'Apply', exact: true }).count(), 1, 'the routine card is decided on its own');
    await page.getByRole('tab', { name: 'This workout', exact: true }).click();
    await page.locator('.gym-live-movement').filter({ hasText: 'Face Pull' }).waitFor();
    assert.deepEqual(await coachSteps(page), {
      opened: [{ screen: 'coach', action: 'new_chat', door: 'workout', outcome: 'ok' }],
      shown: [{ screen: 'coach', target: 'workout', state: 'pending' }, { screen: 'coach', target: 'workout', state: 'applied' }],
      decided: [{ screen: 'coach', target: 'workout', action: 'apply', outcome: 'decided' }] });
    assert.deepEqual(await page.evaluate(() => window.issues ?? []), []);
  });
});

test('Chromium: on a phone Coach is a sheet over the workout at its large detent, its change rejected there, and Close returns to the rack as it was (WD7.1 · 390)', async (t) => {
  const { tab } = await browserWith(t, { width: 390, height: 844 });
  const page = await tab();
  await withBrowserErrors(page, async () => {
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await loggable(page);
    await page.getByRole('button', { name: 'Log set', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
    assert.equal(await page.getByRole('tab').count(), 0, 'a phone has no rail to hold the tabs');
    await page.getByRole('button', { name: 'Coach', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Coach', exact: true });
    await sheet.waitFor();
    assert.deepEqual(await page.evaluate(() => { const box = document.querySelector('dialog.wm-sheet').getBoundingClientRect(); return [box.top, box.bottom]; }), [60, 844]);
    assert.equal(await sheet.getByRole('link', { name: 'History', exact: true }).getAttribute('href'), '#/gym/coach/threads');
    await proposes(page);
    await ask(sheet, 'My shoulder feels off on bench today.');
    await sheet.getByRole('region', { name: 'This workout', exact: true }).getByRole('button', { name: 'Apply', exact: true }).waitFor();
    const field = await sheet.getByRole('textbox', { name: 'Ask about your training', exact: true }).boundingBox();
    assert.ok(field.y + field.height <= 844, 'the composer stays at the sheet\'s foot');
    await sheet.getByRole('region', { name: 'This workout', exact: true }).getByRole('button', { name: 'Reject', exact: true }).click();
    await sheet.getByText('Rejected · this workout', { exact: true }).waitFor();
    assert.deepEqual(await coachSteps(page), {
      opened: [{ screen: 'coach', action: 'new_chat', door: 'workout', outcome: 'ok' }],
      shown: [{ screen: 'coach', target: 'workout', state: 'pending' }, { screen: 'coach', target: 'workout', state: 'rejected' }],
      decided: [{ screen: 'coach', target: 'workout', action: 'reject', outcome: 'decided' }] });
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Coach', 'focus is back on Coach');
    assert.deepEqual(await ledger(page), ['100 × 5']);
    assert.equal(await page.locator('.gym-live-load input').inputValue(), '100');
    assert.equal(await page.locator('.gym-live-movement-title').textContent(), 'Back Squat', 'the movement in hand is the one it was');
  });
});

test('Chromium: a change to a movement logged since its suggestion is out of date, says why in one sentence and applies nothing (WD7.3)', async (t) => {
  const { tab } = await browserWith(t);
  const page = await tab();
  await withBrowserErrors(page, async () => {
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await loggable(page);
    await page.getByRole('tab', { name: 'Coach', exact: true }).click();
    const coach = page.getByRole('tabpanel', { name: 'Coach', exact: true });
    await proposes(page);
    await ask(coach, 'My shoulder feels off on bench today.');
    const card = coach.getByRole('region', { name: 'This workout', exact: true });
    await card.getByRole('button', { name: 'Apply', exact: true }).waitFor();
    for (let step = 0; step < 2; step += 1) await page.getByRole('button', { name: 'Next movement', exact: true }).click();
    await page.locator('.gym-live-movement-title').filter({ hasText: 'Pull Up' }).waitFor();
    await loggable(page);
    await page.getByRole('button', { name: 'Log set', exact: true }).click();
    await card.getByText('You logged Pull Up since this suggestion. Nothing was applied.', { exact: true }).waitFor();
    assert.equal(await card.locator('header').innerText(), 'This workout\nOut of date');
    assert.equal(await card.getByRole('button').count(), 0, 'no buttons');
    assert.deepEqual((await coachSteps(page)).shown, [{ screen: 'coach', target: 'workout', state: 'pending' },
      { screen: 'coach', target: 'workout', state: 'out-of-date', reason: 'workout-moved' }]);
  });
});

// A phone's workout and its conversation, as the browser's copy holds them once they synced: Upper A open since ten
// minutes ago, and the phone's question answered with a change to it, waiting on its card.
function phoneConversation() {
  const at = Date.now() - 600_000;
  const plan = entries.map((entry) => RoutineEntry.decode(Fields.object(entry)));
  const changes = RoutineChange.between(plan, lighter.map((entry) => RoutineEntry.decode(Fields.object(entry)))).map((change) => change.json);
  const record = (t, id, fields) => ({ t, id, born: stamp, life: ['alive', stamp], f: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, [value, stamp]])) });
  return [
    record('session', 'sessionPhone', { startedAt: at, routineId: 'routineUpperA', planRevision: 1, plan: { routine: 'Upper A', entries } }),
    record('thread', 'threadPhone', { title: 'My shoulder feels off on bench today.' }),
    record('message', 'lifterPhone', { threadId: 'threadPhone', role: 'lifter', at, text: 'My shoulder feels off on bench today.', pictures: [] }),
    record('message', 'coachPhone', { threadId: 'threadPhone', role: 'coach', at: at + 1000, replica: `rp_${'1'.repeat(32)}`, text: answer, state: 'completed',
      truncated: false, calls: [{ callId: 'toolu_1', name: 'propose_workout_change', outcome: 'ok', created: [{ t: 'workoutProposal', id: 'proposalPhone' }],
        read: { sessions: [], sets: [], weeks: [] } }] }),
    record('workoutProposal', 'proposalPhone', { sessionId: 'sessionPhone', summary: '', changes, door: 'ask', connection: '', agent: '', baseRevision: 1,
      threadId: 'threadPhone', state: 'pending' }),
  ];
}

test('Chromium: a phone\'s workout proposal stands in History with its card, and applied in one tab it reads applied in the other', async (t) => {
  const { tab } = await browserWith(t, { rows: phoneConversation() });
  const one = await tab('#/gym/coach/threads/threadPhone');
  const two = await tab('#/gym/coach/threads/threadPhone');
  for (const page of [one, two]) await page.getByRole('region', { name: 'This workout', exact: true }).getByRole('button', { name: 'Apply', exact: true }).waitFor();
  assert.equal(await one.getByRole('region', { name: 'This workout', exact: true }).locator('header').innerText(), 'This workout\n2 suggested changes · now');
  await one.getByRole('region', { name: 'This workout', exact: true }).getByRole('button', { name: 'Apply', exact: true }).click();
  for (const page of [one, two]) await page.getByText('Applied · this workout', { exact: true }).waitFor();
  assert.deepEqual(await steps(two, 'gym_proposal_outcome'), [], 'the other tab decided nothing');
  await two.evaluate(() => { window.location.hash = '#/gym/workout'; });
  await two.locator('.gym-live-movement').filter({ hasText: 'Face Pull' }).waitFor();
  assert.deepEqual(await two.evaluate(() => window.issues ?? []), []);
});

// Tab one's Apply waits until tab two has logged a pull-up: the domain then refuses it as out of date, and the card says so
// in its sentence, never as a failure.
test('Chromium: an Apply the domain refuses as out of date is drawn as the card\'s sentence, never as a failure', async (t) => {
  const { tab } = await browserWith(t, { rows: phoneConversation() });
  const one = await tab('#/gym/coach/threads/threadPhone');
  const two = await tab('#/gym/workout');
  const card = one.getByRole('region', { name: 'This workout', exact: true });
  await card.getByRole('button', { name: 'Apply', exact: true }).waitFor();
  await loggable(two);
  await one.evaluate(() => window.holdCommits());
  await card.getByRole('button', { name: 'Apply', exact: true }).click();
  await two.locator('.gym-live-movement').filter({ hasText: 'Pull Up' }).click();
  await two.locator('.gym-live-movement-title').filter({ hasText: 'Pull Up' }).waitFor();
  await loggable(two);
  await two.getByRole('button', { name: 'Log set', exact: true }).click();
  await two.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
  await one.evaluate(() => window.releaseCommits());
  await card.getByText('You logged Pull Up since this suggestion. Nothing was applied.', { exact: true }).waitFor();
  await one.waitForFunction(() => (window.events ?? []).some((event) => event.name === 'gym_proposal_outcome'));
  assert.deepEqual(await steps(one, 'gym_proposal_outcome'), [{ screen: 'coach', target: 'workout', action: 'apply', outcome: 'refused', reason: 'workout-moved' }]);
  assert.equal(await card.getByRole('alert').count(), 0, 'no failure line');
  assert.equal(await said(one), '', 'the room says nothing of it');
  assert.deepEqual(await one.evaluate(() => window.issues ?? []), []);
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

test('Chromium: Coach during a workout at 1440 and 390, for the boards (WD7)', { skip: !process.env.WM_WORKOUT_SHOTS }, async (t) => {
  const shot = (page, name) => page.screenshot({ path: `${process.env.WM_WORKOUT_SHOTS}/${name}.png` });
  // Upper A under way as the boards draw it: two sets of bench press logged, the third in hand.
  const underWay = async (page) => {
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await loggable(page);
    await page.getByRole('button', { name: 'Dumbbell Bench Press, 2 of 3', exact: true }).click();
    await page.locator('.gym-live-movement-title').filter({ hasText: 'Dumbbell Bench Press' }).waitFor();
    for (let set = 0; set < 2; set += 1) {
      await loggable(page);
      await page.getByRole('button', { name: 'Log set', exact: true }).click();
      await page.waitForFunction((count) => document.querySelectorAll('.gym-live-row.is-logged').length === count, set + 1);
    }
  };
  const question = 'My shoulder feels off on bench today. Should I change anything?';

  const desk = await browserWith(t, { width: 1440, height: 1240, colorScheme: 'dark' });
  const wide = await desk.tab();
  await underWay(wide);
  await wide.getByRole('tab', { name: 'Coach', exact: true }).click();
  await proposes(wide, { routine: true });
  const rail = wide.getByRole('tabpanel', { name: 'Coach', exact: true });
  await ask(rail, question);
  await rail.getByRole('region', { name: 'Upper A', exact: true }).getByRole('button', { name: 'Apply', exact: true }).waitFor();
  await wide.mouse.click(5, 600);
  await wide.waitForTimeout(1300);
  await wide.evaluate(() => { document.querySelector('.gym-coach.is-workout .gym-coach-reading').scrollTop = 0; });
  await shot(wide, 'wd7.1-1440');

  const phone = await browserWith(t, { width: 390, height: 844, colorScheme: 'dark' });
  const narrow = await phone.tab();
  await underWay(narrow);
  await narrow.getByRole('button', { name: 'Coach', exact: true }).click();
  const sheet = narrow.getByRole('dialog', { name: 'Coach', exact: true });
  await proposes(narrow, { routine: true });
  await ask(sheet, question);
  const workout = sheet.getByRole('region', { name: 'This workout', exact: true });
  await workout.getByRole('button', { name: 'Apply', exact: true }).waitFor();
  await narrow.evaluate(() => document.activeElement?.blur());
  await narrow.evaluate(() => { document.querySelector('.gym-coach.is-workout .gym-coach-reading').scrollTop = 0; });
  await shot(narrow, 'wd7.1-390');

  // Out of date (WD7.3): a pull-up logged in another tab while the card waits.
  const other = await phone.tab('#/gym/workout');
  await loggable(other);
  await other.getByRole('button', { name: 'Pull Up, 3 of 3', exact: true }).click();
  await other.locator('.gym-live-movement-title').filter({ hasText: 'Pull Up' }).waitFor();
  await loggable(other);
  await other.getByRole('button', { name: 'Log set', exact: true }).click();
  await workout.getByText('You logged Pull Up since this suggestion. Nothing was applied.', { exact: true }).waitFor();
  await narrow.evaluate(() => { document.querySelector('.gym-coach.is-workout .gym-coach-reading').scrollTop = 0; });
  await shot(narrow, 'wd7.3-390');

  // Applied (WD7.2): Coach opened again, a fresh chat, and its change, which leaves the logged pull-ups as they stand, applied.
  await narrow.getByRole('button', { name: 'Close', exact: true }).click();
  await narrow.getByRole('button', { name: 'Coach', exact: true }).click();
  await proposes(narrow, { routine: true });
  await narrow.evaluate((plan) => { window.aiRounds[0].calls[0].input.entries = plan; }, [entries[0], entries[1], entries[2], lighter[3]]);
  await ask(sheet, question);
  await sheet.getByRole('region', { name: 'This workout', exact: true }).getByRole('button', { name: 'Apply', exact: true }).click();
  await sheet.getByText('Applied · this workout', { exact: true }).waitFor();
  await narrow.evaluate(() => document.activeElement?.blur());
  await narrow.evaluate(() => { document.querySelector('.gym-coach.is-workout .gym-coach-reading').scrollTop = 0; });
  await shot(narrow, 'wd7.2-390');
});
