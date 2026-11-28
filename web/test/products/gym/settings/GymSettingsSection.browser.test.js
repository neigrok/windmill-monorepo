import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { GymProduct } from '../../../../../packages/api-contract/sync/reference/gym/product.js';
import { hello, pull } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../../packages/api-contract/sync/reference/server/push.js';
import { Draft } from '../../../../src/platform/domain-kit/drafts.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { Exercise } from '../../../../src/products/gym/domain/catalogue.js';
import { GymRefusals } from '../../../../src/products/gym/domain/gymRules.js';
import { ChangePreferences, Preferences, SaveRestSettings, restSettings } from '../../../../src/products/gym/domain/preferences.js';
import { Routine, RoutineEntry, RoutineValue } from '../../../../src/products/gym/domain/routines.js';
import { SeedExercises } from '../../../../src/products/gym/domain/seedExercises.js';
import { Session } from '../../../../src/products/gym/domain/training.js';
import { StartSession } from '../../../../src/products/gym/domain/trainingActions.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { beacon } from '../../roadmap/browserFixture.js';

// Settings · Your training log on the web (WD10), in Chromium: the real account provider and shell over the browser's own
// engine, every `/v1` request answered by the engine's reference server, which a phone of the same account (the domain
// harness) reads and writes as well. Signed out, the section stands in the account column on the browser's own copy.
// `WM_GYM_SHOTS` names a folder for the boards' screenshots at 1440 and 390.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
const shots = process.env.WM_GYM_SHOTS ?? null;
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import AuthProvider from '/src/shell/auth/AuthProvider.jsx';
import EntitlementsProvider from '/src/shell/billing/EntitlementsProvider.jsx';
import { SignInDoorProvider } from '/src/shell/auth/SignInDoor.jsx';
import { AccountChrome } from '/src/shell/account/AccountChrome.jsx';
import { Shell } from '/src/shell/chrome/Shell.jsx';
import { SettingsPage } from '/src/shell/settings/SettingsPage.jsx';
import { syncSession } from '/src/platform/sync/session.js';
import { GymSettingsSection } from '/src/products/gym/settings/GymSettingsSection.jsx';
import { weightUnit } from '/src/products/gym/units.js';
import '/src/styles/fonts.js';
import '/src/styles/global.css';

function BrowsersOwn() {
  return React.createElement(AccountChrome, { width: 540, bare: true }, React.createElement(GymSettingsSection));
}
window.mount = (signedIn) => {
  const neutral = signedIn ? { Component: SettingsPage, props: { inShell: true } } : { Component: BrowsersOwn, props: {} };
  createRoot(document.getElementById('root')).render(React.createElement(AuthProvider, null,
    React.createElement(EntitlementsProvider, null,
      React.createElement(SignInDoorProvider, null,
        React.createElement(Shell, { location: { pathname: '/app/settings', hash: '', search: '' }, neutral })))));
};
window.replica = () => syncSession.engine?.getSnapshot() ?? null;
window.outbox = () => syncSession.engine.device.activeReplica.outbox.length;
window.pulled = () => syncSession.engine.observe('self/gym').getSnapshot().firstPullComplete;
window.prefs = () => syncSession.engine.observe('self/gym').getSnapshot().drawn.find((record) => record.t === 'prefs')?.f ?? null;
window.unit = () => weightUnit();
// This tab's engine writes break from here on, as a bug in one would.
window.breakCommits = () => { syncSession.engine.commit = async () => { throw new Error('the write broke'); }; };
window.entryReady = true;
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-gym-settings-test`,
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('') },
    plugins: [{ name: 'gym-settings-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/gym-settings-entry.js') return '\0gym-settings-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0gym-settings-events';
        if (id.endsWith('/telemetry/sentry.js')) return '\0gym-settings-issues';
      },
      load(id) {
        if (id === '\0gym-settings-entry') return entry;
        if (id === '\0gym-settings-events') return beacon;
        if (id === '\0gym-settings-issues') return 'export function captureError(product, operation) { (window.issues ??= []).push(operation); }';
      },
      configureServer(vite) {
        vite.middlewares.use('/gym-settings', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Gym settings test</title><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/gym-settings-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => {
  try { await ready; } finally { await browser?.close(); await server?.close(); }
});

// Account A on the reference server and its phone: a default rest of 2:00, as the boards draw it, and when `open` the
// routine Upper A started ten minutes ago.
async function account(t, { open = false } = {}) {
  const phone = await Harness.open({ registry, product: new GymProduct(), scope: Session.scope, start: Date.now() });
  t.after(() => phone.close());
  phone.server.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  assert.equal((await phone.runner.run(SaveRestSettings({ restSeconds: 120 }))).kind, 'committed');
  if (open) {
    const routine = new Id('routineUpperA', Routine);
    const saved = await phone.runner.save(Draft.new(new RoutineValue(routine, 'Upper A', 0, [new RoutineEntry(new Id('bench-press', Exercise))])), GymRefusals);
    assert.equal(saved.result.kind, 'saved');
    assert.equal((await phone.runner.run(StartSession({ id: new Id('phoneOpen1', Session), routineId: routine }))).kind, 'committed');
  }
  await phone.sync();
  return phone;
}

// A browser of its own whose `/v1` the reference server answers over `phone`'s state, signed in as A or not; what the server
// does not serve is held, as no answer at all. Its pulls wait for `pullsWaitFor` where it is given, and the visit then ends
// as the replica is bound, before the section can draw.
async function visit(t, phone, { signedIn, width = 1440, height = 1000, pullsWaitFor = null }) {
  await ready;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'dark' });
  context.setDefaultTimeout(20000);
  t.after(() => context.close());
  await context.routeWebSocket(/\/v1\//, () => {});
  await context.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const account = signedIn ? 'A' : null;
    if (path === '/v1/me') return json(200, { user: account ? { id: 'A', name: 'Ann', email: 'ann@example.com' } : null });
    if (path === '/v1/sync/hello') {
      const answer = hello({ state: phone.world.server, registry, account, serverTime: Date.now() });
      return json(answer.status, answer.body);
    }
    if (path === '/v1/sync/push' || path === '/v1/sync/pull') {
      if (path.endsWith('pull')) await pullsWaitFor;
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
  await page.goto(`${origin}/gym-settings`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate((seat) => window.mount(seat), signedIn);
  await page.waitForFunction((state) => window.replica()?.state === state, signedIn ? 'bound' : 'anon');
  if (pullsWaitFor) return page;
  if (signedIn) await page.waitForFunction(() => window.pulled());
  await page.getByText('Rest sound', { exact: true }).waitFor();
  return page;
}

const rows = (page) => page.evaluate(() => Array.from([...document.querySelectorAll('section')].find((section) => section.querySelector('h2')?.textContent === 'Your training log')
  .querySelectorAll(':scope > div, :scope > a')).map((row) => row.innerText.replace(/\s+/g, ' ').trim()));
// The line under a row's label, once it reads `words`.
const says = (page, label, words) => page.waitForFunction(([label, words]) => [...document.querySelectorAll('span')]
  .some((span) => span.textContent === label && span.nextElementSibling?.textContent === words), [label, words], { timeout: 5000 });
const events = (page) => page.evaluate(() => (window.events ?? []).filter((event) => event.name === 'gym_preference_changed').map((event) => event.props));
const shoot = async (page, name) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
  await page.screenshot({ path: `${shots}/${name}.png` });
};
// What the phone reads once it has pulled what the page pushed.
async function phoneReads(page, phone) {
  await page.waitForFunction(() => window.outbox() === 0);
  await phone.sync();
  const rest = phone.runner.read(Preferences.scope, restSettings);
  return { seconds: rest.seconds, sound: rest.sound };
}

test('Chromium: signed in, Default rest and Rest sound sit between Units and Notes, apply at once, and the phone reads them', async (t) => {
  const phone = await account(t);
  const page = await visit(t, phone, { signedIn: true });
  assert.deepEqual(await rows(page), ['Units kg lb', 'Default rest For movements on Default 2:00', 'Rest sound A tone and a buzz when rest is up',
    'Notes what you write for Coach ›']);
  const rest = page.getByRole('combobox', { name: 'Default rest', exact: true });
  assert.equal(await page.getByRole('switch', { name: 'Rest sound', exact: true }).isChecked(), true);

  await rest.focus();
  await page.keyboard.press('Enter');
  const listbox = page.getByRole('listbox');
  assert.deepEqual(await listbox.getByRole('option').allInnerTexts(), ['Off', '0:30', '1:00', '1:30', '2:00', '2:30', '3:00', '4:00', '5:00']);
  assert.equal(await listbox.getByRole('option', { selected: true }).innerText(), '2:00');
  const [trigger, list] = await Promise.all([rest.boundingBox(), listbox.boundingBox()]);
  assert.equal(Math.round(list.x + list.width), Math.round(trigger.x + trigger.width), 'the listbox hangs under the trigger’s right edge');
  await page.keyboard.press('Escape');
  assert.equal(await listbox.count(), 0);
  assert.equal(new URL(page.url()).pathname, '/gym-settings', 'Escape closes the listbox and leaves the page where it is');

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  assert.equal(await rest.innerText(), '1:30');
  await says(page, 'Default rest', 'Saved.');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'combobox', 'the focus stays on the trigger');
  await says(page, 'Default rest', 'For movements on Default');
  assert.deepEqual(await phoneReads(page, phone), { seconds: 90, sound: true });

  await page.getByRole('switch', { name: 'Rest sound', exact: true }).locator('xpath=..').click();
  await says(page, 'Rest sound', 'Saved.');
  assert.deepEqual(await phoneReads(page, phone), { seconds: 90, sound: false });

  await rest.click();
  await listbox.getByRole('option', { name: 'Off', exact: true }).click();
  assert.equal(await rest.innerText(), 'Off');
  await says(page, 'Default rest', 'Saved.');
  assert.deepEqual(await phoneReads(page, phone), { seconds: null, sound: false });
  assert.deepEqual(await events(page), [{ setting: 'rest_default', outcome: 'saved' }, { setting: 'rest_sound', outcome: 'saved' },
    { setting: 'rest_default', outcome: 'saved' }]);
  assert.deepEqual(await page.evaluate(() => window.issues ?? []), []);
});

test('Chromium: while a workout is open on the phone, Default rest names it, and a new default reaches it', async (t) => {
  const phone = await account(t, { open: true });
  const page = await visit(t, phone, { signedIn: true });
  await says(page, 'Default rest', 'For movements on Default · Upper A follows it');
  await page.getByRole('combobox', { name: 'Default rest', exact: true }).click();
  await page.getByRole('option', { name: '1:30', exact: true }).click();
  await says(page, 'Default rest', 'Saved.');
  await says(page, 'Default rest', 'For movements on Default · Upper A follows it');
  assert.deepEqual(await phoneReads(page, phone), { seconds: 90, sound: true });
});

test('Chromium: signed in, the section draws nothing while the first pull runs, then the account’s lb and 2:00', async (t) => {
  const phone = await account(t);
  assert.equal((await phone.runner.run(ChangePreferences({ units: 'lb' }))).kind, 'committed');
  await phone.sync();
  let release;
  const page = await visit(t, phone, { signedIn: true, pullsWaitFor: new Promise((resolve) => { release = resolve; }) });
  await page.getByRole('heading', { name: 'Your journal', exact: true }).waitFor();
  await page.waitForTimeout(1000);
  assert.deepEqual([await page.evaluate(() => window.pulled()), await page.getByRole('heading', { name: 'Your training log', exact: true }).count(),
    await page.evaluate(() => window.unit())], [false, 0, 'kg']);
  release();
  await page.getByText('Rest sound', { exact: true }).waitFor();
  assert.deepEqual(await rows(page), ['Units kg lb A backfill, a correction, a routine target — typed in kg.', 'Default rest For movements on Default 2:00',
    'Rest sound A tone and a buzz when rest is up', 'Notes what you write for Coach ›']);
  assert.deepEqual([await page.getByRole('button', { name: 'lb', exact: true }).getAttribute('aria-pressed'), await page.evaluate(() => window.unit())],
    ['true', 'lb']);
});

test('Chromium: a rest save that breaks is told failed and reported as gym-rest-save, its value never', async (t) => {
  const page = await visit(t, await account(t), { signedIn: true });
  await page.evaluate(() => window.breakCommits());
  await page.getByRole('combobox', { name: 'Default rest', exact: true }).click();
  await page.getByRole('option', { name: '1:30', exact: true }).click();
  await page.getByText('That setting didn’t save', { exact: false }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Default rest', exact: true }).innerText(), '2:00');
  assert.deepEqual([await events(page), await page.evaluate(() => window.issues ?? [])],
    [[{ setting: 'rest_default', outcome: 'failed' }], ['gym-rest-save']]);
});

test('Chromium: signed out, the section runs on the browser’s own copy, Off and sound on, with no Notes', async (t) => {
  const phone = await account(t);
  const page = await visit(t, phone, { signedIn: false });
  assert.deepEqual(await rows(page), ['Units kg lb', 'Default rest For movements on Default Off', 'Rest sound A tone and a buzz when rest is up']);
  await page.getByRole('combobox', { name: 'Default rest', exact: true }).click();
  await page.getByRole('option', { name: '3:00', exact: true }).click();
  await says(page, 'Default rest', 'Saved.');
  assert.deepEqual((await page.evaluate(() => window.prefs())).restSeconds[0], 180);
  assert.equal(await page.evaluate(() => window.replica().state), 'anon');
  assert.deepEqual(await events(page), [{ setting: 'rest_default', outcome: 'saved' }]);
});

test('Chromium: the boards, WD10.1–10.3 and 10.5 at 1440 and 390', { skip: !shots }, async (t) => {
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    const signedIn = await visit(t, await account(t), { signedIn: true, width, height });
    await shoot(signedIn, `wd10.1-${width}`);
    await signedIn.getByRole('combobox', { name: 'Default rest', exact: true }).focus();
    await signedIn.keyboard.press('Enter');
    await signedIn.keyboard.press('ArrowUp');
    await shoot(signedIn, `wd10.2-${width}`);
    await signedIn.keyboard.press('Enter');
    await says(signedIn, 'Default rest', 'Saved.');
    await signedIn.evaluate(() => document.activeElement.blur());
    await shoot(signedIn, `wd10.3-${width}`);
    await shoot(await visit(t, await account(t), { signedIn: false, width, height }), `wd10.5-${width}`);
  }
});
