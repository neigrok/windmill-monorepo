import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { GymProduct } from '../../../../packages/api-contract/sync/reference/gym/product.js';
import { hello, pull } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';
import { Id } from '../../../src/platform/domain-kit/entities.js';
import { Instant } from '../../../src/platform/domain-kit/time.js';
import { registry } from '../../../src/platform/sync/schema.js';
import { Exercise } from '../../../src/products/gym/domain/catalogue.js';
import { SeedExercises } from '../../../src/products/gym/domain/seedExercises.js';
import { Session, TrainingSet } from '../../../src/products/gym/domain/training.js';
import { ImportedSet, ImportSession, StartSession } from '../../../src/products/gym/domain/trainingActions.js';
import { Harness } from '../../platform/domain-kit/harness.js';
import { beacon } from '../roadmap/browserFixture.js';

// The gym room signed out (web-device-parity §3, WD8), the sign-in that joins its work to an account holding training of
// its own (WD9), and a start that lost a race (§4, WD4.3), in Chromium: the real account provider and shell over the
// browser's own engine, and every `/v1` request answered by the engine's reference server, which a phone of the same
// account (the domain harness) writes to as well. `WM_GYM_SHOTS` names a folder for the boards' screenshots.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const shots = process.env.WM_GYM_SHOTS ?? null;
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import AuthProvider from '/src/shell/auth/AuthProvider.jsx';
import { SignInDoorProvider } from '/src/shell/auth/SignInDoor.jsx';
import { Shell } from '/src/shell/chrome/Shell.jsx';
import { syncSession } from '/src/platform/sync/session.js';
import { ActionRunner, EngineReplica } from '/src/platform/domain-kit/runner.js';
import { Id } from '/src/platform/domain-kit/entities.js';
import { Instant } from '/src/platform/domain-kit/time.js';
import { createGymApi, deviceZone } from '/src/products/gym/gymRuntime.js';
import { Exercise } from '/src/products/gym/domain/catalogue.js';
import { Routine } from '/src/products/gym/domain/routines.js';
import { Session, TrainingSet, TrainingSetValue } from '/src/products/gym/domain/training.js';
import { AppendSet, FinishSession, StartSession } from '/src/products/gym/domain/trainingActions.js';
import '/src/styles/global.css';

let root = null;
const draw = () => root.render(React.createElement(AuthProvider, null, React.createElement(SignInDoorProvider, null,
  React.createElement(Shell, { location: { pathname: '/app/gym', hash: window.location.hash, search: '' } }))));
window.mount = (hash) => {
  window.location.hash = hash;
  root = createRoot(document.getElementById('root'));
  draw();
  window.addEventListener('hashchange', draw);
};
window.replica = () => syncSession.engine?.getSnapshot() ?? null;
window.gym = () => createGymApi(syncSession.engine);
// A workout the person logs in this tab, through the gym domain on this page's engine: its start, each set, and its finish
// when \`finishedAt\` is given.
window.logWorkout = async ({ id, routineId = null, startedAt, sets, finishedAt = null }) => {
  const engine = syncSession.engine;
  const runner = new ActionRunner(new EngineReplica(engine), engine.registry, deviceZone);
  const session = new Id(id, Session);
  const started = await runner.run(StartSession({ id: session, routineId: routineId === null ? null : new Id(routineId, Routine), startedAt: new Instant(startedAt) }));
  if (started.kind !== 'committed') throw new Error('the start was ' + started.kind);
  for (const [index, set] of sets.entries()) {
    const logged = await runner.run(AppendSet(new TrainingSetValue(new Id(id + 's' + index, TrainingSet), session, new Id(set.exerciseId, Exercise),
      set.weightKg, set.reps, new Instant(set.completedAt))));
    if (logged.kind !== 'committed') throw new Error('a set was ' + logged.kind);
  }
  if (finishedAt !== null && (await runner.run(FinishSession({ id: session, finishedAt: new Instant(finishedAt) }))).kind !== 'committed') throw new Error('the finish failed');
};
// The days a weigh-in is written for, local to this browser: \`ago\` days before today.
window.dayAgo = (ago) => {
  const day = new Date();
  day.setDate(day.getDate() - ago);
  return day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0');
};
window.entryReady = true;
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-gym-signed-out-test`,
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('') },
    plugins: [{ name: 'gym-signed-out-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/gym-signed-out-entry.js') return '\0gym-signed-out-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0gym-signed-out-events';
        if (id.endsWith('/telemetry/sentry.js')) return '\0gym-signed-out-issues';
      },
      load(id) {
        if (id === '\0gym-signed-out-entry') return entry;
        if (id === '\0gym-signed-out-events') return beacon;
        if (id === '\0gym-signed-out-issues') return 'export function captureError(product, operation) { (window.issues ??= []).push(operation); }';
      },
      configureServer(vite) {
        vite.middlewares.use('/gym-signed-out', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Gym signed out test</title><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/gym-signed-out-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => {
  try { await ready; } finally { await browser?.close(); await server?.close(); }
});

const minute = 60_000;
// The day an instant `ago` before now falls on, as the room says it: today, or yesterday just after midnight.
const dayBefore = (ago) => (new Date(Date.now() - ago).toDateString() === new Date().toDateString() ? 'today' : 'yesterday');
const capital = (word) => word[0].toUpperCase() + word.slice(1);

// Account A on the reference server, its phone the domain harness writing through the same state the page reads: a workout
// finished yesterday, so the account holds training, and, when `open`, a workout started on the phone ten minutes ago.
async function account(t, { open = false } = {}) {
  const phone = await Harness.open({ registry, product: new GymProduct(), scope: Session.scope, start: Date.now() });
  t.after(() => phone.close());
  phone.server.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  const yesterday = Date.now() - 24 * 60 * minute;
  const done = await phone.runner.run(ImportSession({ id: new Id('phoneDone1', Session), startedAt: new Instant(yesterday), finishedAt: new Instant(yesterday + 40 * minute),
    sets: [new ImportedSet({ id: new Id('phoneDone1s0', TrainingSet), exerciseId: new Id('deadlift', Exercise), weightKg: 140, reps: 5, completedAt: new Instant(yesterday + 10 * minute) })] }));
  assert.equal(done.kind, 'committed');
  if (open) assert.equal((await phone.runner.run(StartSession({ id: new Id('phoneOpen1', Session), startedAt: new Instant(Date.now() - 10 * minute) }))).kind, 'committed');
  await phone.sync();
  return phone;
}

// A browser of its own whose `/v1` the reference server answers over `phone`'s state, signed in as A once `seat.signedIn`.
// What the page sends that the server does not serve is held, as no answer at all, so no failed load reaches the console.
async function visit(t, phone, { signedIn, hash = '#/gym', width = 1440, height = 1000 }) {
  await ready;
  const context = await browser.newContext({ viewport: { width, height } });
  context.setDefaultTimeout(20000);
  t.after(() => context.close());
  const seat = { signedIn };
  await context.routeWebSocket(/\/v1\//, () => {});
  await context.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const account = seat.signedIn ? 'A' : null;
    if (path === '/v1/me') return json(200, { user: account ? { id: 'A', name: 'Ann' } : null });
    if (path === '/v1/sync/hello') {
      const answer = hello({ state: phone.world.server, registry, account, serverTime: Date.now() });
      return json(answer.status, answer.body);
    }
    if (path === '/v1/sync/push' || path === '/v1/sync/pull') {
      const out = (path.endsWith('push') ? push : pull)({ state: phone.world.server, registry, product: phone.world.product, account,
        request: request.postDataJSON(), serverNow: Date.now() });
      phone.world.server = out.state;
      return json(out.response.status, out.response.body);
    }
    return undefined;
  });
  const page = await context.newPage();
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
  t.after(() => assert.deepEqual(failures, [], 'the page logged no error'));
  await page.goto(`${origin}/gym-signed-out`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate((at) => window.mount(at), hash);
  await page.waitForFunction(() => window.replica()?.state === 'anon' || window.replica()?.state === 'bound');
  return { context, page, seat };
}

// Signed out: two routines, three weigh-ins and an open workout on Push day with one set, written by the person in this tab;
// with `finished`, a Pull day finished earlier today as well.
async function signedOutWork(page, { finished = false } = {}) {
  await page.evaluate(async ({ now, finished }) => {
    const gym = window.gym();
    const entries = (ids) => ids.map((exerciseId) => ({ exerciseId, sets: [{ reps: 8 }, { reps: 8 }, { reps: 8 }] }));
    await gym.createRoutine({ id: 'rt_pushday1', name: 'Push day', position: 0, entries: entries(['bench-press', 'overhead-press']) });
    await gym.createRoutine({ id: 'rt_pullday1', name: 'Pull day', position: 1, entries: entries(['deadlift']) });
    for (const ago of [7, 3, 0]) await gym.saveBodyweight(window.dayAgo(ago), { weightKg: 80 + ago / 10 });
    if (finished) await window.logWorkout({ id: 'pullday01', routineId: 'rt_pullday1', startedAt: now - 3 * 60 * 60_000,
      sets: [{ exerciseId: 'deadlift', weightKg: 120, reps: 5, completedAt: now - 170 * 60_000 }], finishedAt: now - 150 * 60_000 });
    await window.logWorkout({ id: 'pushday01', routineId: 'rt_pushday1', startedAt: now - 2 * 60_000,
      sets: [{ exerciseId: 'bench-press', weightKg: 60, reps: 8, completedAt: now - 60_000 }] });
  }, { now: Date.now(), finished });
}

// The question the sign-in asks, as its dialog draws it.
async function question(page) {
  const dialog = page.getByRole('dialog', { name: 'Add to your account?', exact: true });
  await dialog.locator('.wm-decision-lead').waitFor();
  return { dialog, said: {
    lead: await dialog.locator('.wm-decision-lead').innerText(),
    items: await dialog.locator('.wm-decision-items li').evaluateAll((rows) => rows.map((row) => [...row.children].map((part) => part.textContent))),
    note: await dialog.locator('.wm-decision-note').innerText(),
    answers: await dialog.getByRole('button').allInnerTexts(),
  } };
}

const events = (page, name) => page.evaluate((wanted) => (window.events ?? []).filter((event) => event.name === wanted).map((event) => event.props), name);
const shoot = async (page, name) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
  await page.screenshot({ path: `${shots}/${name}.png` });
};

test('Chromium: signed out, the gym room is the room on the browser’s copy, without the account’s doors (WD8.1–8.3)', async (t) => {
  const phone = await account(t);
  const { page } = await visit(t, phone, { signedIn: false });
  await page.waitForFunction(() => window.replica().state === 'anon');
  await signedOutWork(page, { finished: true });
  await page.locator('.gym-routine-name', { hasText: 'Pull day' }).waitFor();
  assert.deepEqual(await page.locator('.gym-routine-name').allTextContents(), ['Push day', 'Pull day']);
  assert.equal(await page.locator('.gym-door').count(), 0, 'no sign-in pitch stands in the room’s place');
  await page.getByRole('button', { name: 'More for Pull day', exact: true }).click();
  assert.deepEqual(await page.getByRole('menuitem').allInnerTexts(), ['Delete'], 'Log past, a server command, is left out');
  await page.keyboard.press('Escape');
  await shoot(page, 'wd8.1-1440');
  await page.setViewportSize({ width: 390, height: 844 });
  await shoot(page, 'wd8.1-390');
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.evaluate(() => { window.location.hash = '#/gym/log'; });
  await page.locator('.gym-history-index .gym-row-title', { hasText: 'Pull day' }).waitFor();
  assert.deepEqual({
    share: await page.locator('.gym-history-share').count(),
    past: await page.locator('.gym-door-past').count(),
    weigh: await page.locator('.gym-history-actions .gym-history-weigh').isVisible(),
    copies: await page.locator('.gym-browser-copies').count(),
    said: await page.getByText(/this (browser|device)/i).count(),
  }, { share: 0, past: 0, weigh: true, copies: 0, said: 0 }, 'The log reads the browser’s training, says nothing of where it is kept, and leaves out the account’s doors');

  for (const hash of ['#/gym/coach', '#/gym/notes']) {
    await page.evaluate((at) => { window.location.hash = at; }, hash);
    const door = page.locator('.gym-door');
    await door.waitFor();
    assert.deepEqual([await door.locator('h1').innerText(), await door.locator('.gym-door-line').innerText(), await door.getByRole('button').innerText()],
      ['Coach', 'Coach reads your training and suggests changes you apply. Sign in to use it.', 'Sign in'], `${hash} is Coach’s door`);
  }
  assert.deepEqual(await page.evaluate(() => window.issues ?? []), []);
});

test('Chromium: a sign-in into an account with training asks once in gym’s count; Add joins the work, and the open workout the account cannot take waits In this browser until kept as finished (WD9.1, WD9.3)', async (t) => {
  const phone = await account(t, { open: true });
  const { page, seat } = await visit(t, phone, { signedIn: false });
  await page.waitForFunction(() => window.replica().state === 'anon');
  await signedOutWork(page);
  seat.signedIn = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const { dialog, said } = await question(page);
  assert.deepEqual(said, {
    lead: 'This browser has 1 workout, 2 routines, and 3 weigh-ins from before you signed in. Your account already has training.',
    items: [['1 workout', `Push day · ${dayBefore(2 * minute)}`], ['2 routines', 'Push day · Pull day'], ['3 weigh-ins', `since ${await page.evaluate(() => {
      const day = new Date();
      day.setDate(day.getDate() - 7);
      return `${day.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][day.getMonth()]}`;
    })}`]],
    note: 'Add them, or discard them from this browser.',
    answers: ['Cancel sign-in', 'Discard', 'Add'],
  });
  await shoot(page, 'wd9.1-1440');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.wm-decision--page').waitFor();
  assert.deepEqual(await page.getByRole('dialog').getByRole('button').allInnerTexts(), ['Add', 'Discard', 'Cancel sign-in']);
  await shoot(page, 'wd9.1-390');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.wm-decision--dialog').waitFor();

  await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.replica().state === 'bound');
  await page.evaluate(() => { window.location.hash = '#/gym/log'; });
  const card = page.locator('.gym-browser-copies.is-wide .gym-browser-copy');
  await card.locator('.gym-browser-copy-line', { hasText: 'Your account has a workout open.' }).waitFor();
  assert.deepEqual([await page.locator('.gym-browser-copies.is-wide h2').innerText(), await card.locator('.gym-browser-copy-title').innerText(),
    (await card.locator('.gym-browser-copy-meta').innerText()).replace(/\d{2}:\d{2}/, 'HH:MM'), await card.getByRole('button').allInnerTexts()],
  ['IN THIS BROWSER', 'Push day', `${capital(dayBefore(2 * minute))}, HH:MM · 1 set`, ['⋯', 'Keep as finished']]);
  await shoot(page, 'wd9.3-1440');
  await card.getByRole('button', { name: 'Keep as finished', exact: true }).click();
  await page.locator('.gym-browser-copies').first().waitFor({ state: 'detached' });
  await page.locator('.gym-history-index .gym-row-title', { hasText: 'Push day' }).waitFor();
  assert.deepEqual({
    decision: await events(page, 'gym_signin_decision'),
    recovery: await events(page, 'gym_recovery'),
    issues: await page.evaluate(() => window.issues ?? []),
  }, { decision: [{ choice: 'add', count_bucket: '6-20' }], recovery: [{ outcome: 'kept', reason: 'session-open' }], issues: [] });
  await page.evaluate(() => { window.location.hash = '#/gym'; });
  await page.locator('.gym-routine-name', { hasText: 'Pull day' }).waitFor();
  assert.deepEqual(await page.locator('.gym-routine-name').allTextContents(), ['Push day', 'Pull day'], 'the routines joined the account');
});

test('Chromium: Discard asks again in the browser’s words, and its Discard leaves the account’s training alone and the browser’s work gone (WD9.2)', async (t) => {
  const phone = await account(t);
  const { page, seat } = await visit(t, phone, { signedIn: false });
  await page.waitForFunction(() => window.replica().state === 'anon');
  await signedOutWork(page);
  seat.signedIn = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const { dialog } = await question(page);
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Discard 1 workout, 2 routines, and 3 weigh-ins?', exact: true });
  await confirm.waitFor();
  assert.deepEqual([await confirm.locator('.wm-decision-lead').innerText(), await confirm.getByRole('button').allInnerTexts()],
    ['They are deleted from this browser. You can’t undo this.', ['Cancel', 'Discard']]);
  await shoot(page, 'wd9.2-1440');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await question(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
  await confirm.getByRole('button', { name: 'Discard', exact: true }).click();
  await confirm.waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.replica().state === 'bound');
  await page.evaluate(() => { window.location.hash = '#/gym/log'; });
  await page.locator('.gym-history-index .gym-row-title').first().waitFor();
  assert.deepEqual({
    log: await page.locator('.gym-history-index .gym-row-title').allTextContents(),
    copies: await page.locator('.gym-browser-copies').count(),
    decision: await events(page, 'gym_signin_decision'),
    issues: await page.evaluate(() => window.issues ?? []),
  }, { log: ['Free session'], copies: 0, decision: [{ choice: 'discard', count_bucket: '6-20' }], issues: [] });
  await page.evaluate(() => { window.location.hash = '#/gym'; });
  await page.locator('.gym-routines, .gym-plan-empty').first().waitFor();
  assert.equal(await page.locator('.gym-routine-name').count(), 0, 'the browser’s routines did not reach the account');
});

test('Chromium: a start that lost the race to the phone’s keeps its sets: the toast once, its sets In this browser, kept as finished (WD4.3)', async (t) => {
  const phone = await account(t);
  const { context, page } = await visit(t, phone, { signedIn: true, hash: '#/gym/log' });
  await page.locator('.gym-history-index .gym-row-title', { hasText: 'Free session' }).waitFor();
  await context.setOffline(true);
  await page.evaluate(async (now) => window.logWorkout({ id: 'lostrace01', startedAt: now - 3 * 60_000, sets: [
    { exerciseId: 'back-squat', weightKg: 100, reps: 5, completedAt: now - 2 * 60_000 }, { exerciseId: 'back-squat', weightKg: 105, reps: 5, completedAt: now - 60_000 }] }), Date.now());
  phone.world.now = Date.now();
  assert.equal((await phone.runner.run(StartSession({ id: new Id('phoneOpen2', Session), startedAt: new Instant(Date.now() - 6 * minute) }))).kind, 'committed');
  await phone.sync();
  await context.setOffline(false);
  const toast = page.locator('.gym-toast-slot', { hasText: 'Your account already had a workout open. Your 2 sets are in The log.' });
  await toast.waitFor();
  await shoot(page, 'wd4.3-1440');
  await toast.getByRole('button', { name: 'View sets', exact: true }).click();
  const card = page.locator('.gym-browser-copies.is-wide .gym-browser-copy');
  await card.locator('.gym-browser-copy-line', { hasText: 'Your account has a workout open.' }).waitFor();
  assert.deepEqual([await card.locator('.gym-browser-copy-title').innerText(), (await card.locator('.gym-browser-copy-meta').innerText()).replace(/\d{2}:\d{2}/, 'HH:MM')],
    ['Free session', `${capital(dayBefore(3 * minute))}, HH:MM · 2 sets`]);
  await card.getByRole('button', { name: 'Keep as finished', exact: true }).click();
  await page.locator('.gym-browser-copies').first().waitFor({ state: 'detached' });
  await page.locator('.gym-history-index .gym-row-title').nth(1).waitFor();
  assert.deepEqual({ recovery: await events(page, 'gym_recovery'), issues: await page.evaluate(() => window.issues ?? []) },
    { recovery: [{ outcome: 'saved', reason: 'session-open' }, { outcome: 'kept', reason: 'session-open' }], issues: [] }, 'saved, and so said, once');
});
