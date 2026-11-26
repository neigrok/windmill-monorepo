import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GymProduct } from '../../../../packages/api-contract/sync/reference/gym/product.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { registry } from '../../../src/platform/sync/schema.js';
import { SeedExercises } from '../../../src/products/gym/domain/seedExercises.js';
import { withBrowserErrors } from '../roadmap/browserFixture.js';
import { browserWith, ledger, loggable, steps, engineOpen, said } from './workoutFixture.mjs';

// A workout in Chromium over `workoutFixture.mjs`: started, logged, corrected, edited across tabs and offline, finished.
// `WM_WORKOUT_SHOTS` names a folder for the logging page's screenshots at 1440 and 390.

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
  assert.deepEqual(await two.locator('.gym-live-edit').getByRole('button').allTextContents(), ['×', '×', '×', 'Use latest', 'Save mine'],
    'while the answer stands, Add set, Swap and Remove wait');
  assert.equal(await two.locator('.gym-live-edit').getByRole('combobox', { name: 'Rest', exact: true }).textContent(), '2:00▾',
    'the rest, named by its label, stays to change');
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
