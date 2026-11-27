import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmed } from './harness.mjs';
import { browserWith, loggable, steps, engineOpen, stamp, entries } from './workoutFixture.mjs';

// The rest in Chromium over `workoutFixture.mjs`: the tab's title and favicon following its clock, and the rest reached
// told, toned and buzzed once, as Settings' Default rest and Rest sound change it (WD10.7).

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

test('Chromium: a new default rest the rest has passed is told at once, sounded by a Rest sound turned on after Log set, and with it off the next is told in quiet', async (t) => {
  // A movement on Default, which has no rest of its own, so the rest's target is the default rest, Off until Settings sets it.
  const { tab } = await browserWith(t, { rows: [{ t: 'routine', id: 'routineQuick', born: stamp, life: ['alive', stamp],
    f: { name: ['Quick', stamp], position: [1, stamp], entries: [[{ exerciseId: 'face-pull', sets: [{ reps: 15, weightKg: 15 }, { reps: 15, weightKg: 15 }, { reps: 15, weightKg: 15 }] }], stamp] } }] });
  const page = await tab();
  await engineOpen(page);
  await page.evaluate(() => window.restSetting({ restSound: false }));
  await page.locator('.gym-routine').filter({ hasText: 'Quick' }).getByRole('button', { name: 'Start', exact: true }).click();
  await loggable(page);
  await page.getByRole('button', { name: 'Log set', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
  await page.waitForTimeout(16000);
  assert.equal(await page.locator('.gym-live-clocks.is-reached').count(), 0, 'Off sets no target');
  await page.evaluate(() => window.restSetting({ restSound: true }));
  await page.evaluate(() => window.restSetting({ restSeconds: 15 }));
  await page.locator('.gym-live-clocks.is-reached').waitFor();
  await page.waitForFunction(() => (window.events ?? []).some((event) => event.name === 'gym_rest_target_reached'));
  assert.deepEqual([await steps(page, 'gym_rest_target_reached'), await page.evaluate(() => window.sounded)],
    [[{ screen: 'workout' }], { tones: 1, buzzes: [10] }]);

  await page.evaluate(() => window.restSetting({ restSound: false }));
  await loggable(page);
  await page.getByRole('button', { name: 'Log set', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 2);
  await page.waitForFunction(() => (window.events ?? []).filter((event) => event.name === 'gym_rest_target_reached').length === 2, null, { timeout: 30000 });
  assert.deepEqual(await page.evaluate(() => window.sounded), { tones: 1, buzzes: [10] }, 'Rest sound off: no tone and no buzz');
});

test('Chromium: turning the rack to a movement whose rest has already passed tells, tones and buzzes nothing', async (t) => {
  // A Face Pull set logged 20 s ago, in a workout whose Face Pull rests 10:00 and whose Pull Up rests 0:15.
  const now = Date.now();
  const { tab } = await browserWith(t, { rows: [
    confirmed('session', 'sessionTurn', { startedAt: now - 60_000, plan: { routine: 'Turn', entries: [
      { exerciseId: 'face-pull', sets: [{ reps: 15, weightKg: 15 }, { reps: 15, weightKg: 15 }], restSeconds: 600 },
      { exerciseId: 'pull-up', sets: [{ reps: 8, weightKg: 0 }, { reps: 8, weightKg: 0 }], restSeconds: 15 }] } }),
    confirmed('set', 'setTurn0001', { sessionId: 'sessionTurn', exerciseId: 'face-pull', setNumber: 1, weightKg: 15, reps: 15, note: '',
      completedAt: now - 20_000 }),
  ] });
  const page = await tab('#/gym/workout');
  await page.locator('.gym-live-movement-title').filter({ hasText: 'Face Pull' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.gym-live-row.is-logged').length === 1);
  await page.locator('.gym-live-movement').filter({ hasText: 'Pull Up' }).click();
  await page.locator('.gym-live-movement-title').filter({ hasText: 'Pull Up' }).waitFor();
  await page.locator('.gym-live-clocks.is-reached').waitFor();
  await page.waitForTimeout(1000);
  assert.deepEqual([await steps(page, 'gym_rest_target_reached'), await page.evaluate(() => window.sounded)], [[], { tones: 0, buzzes: [] }]);
});
