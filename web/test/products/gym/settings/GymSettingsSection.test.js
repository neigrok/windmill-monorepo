import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { syncSession } from '../../../../src/platform/sync/session.js';
import { KG, LB, spellWeightsIn, weightUnit } from '../../../../src/products/gym/units.js';
import { createGymApi } from '../../../../src/products/gym/gymRuntime.js';
import { environment, until } from '../../../platform/sync/fakes.js';
import { browserWith, confirmed, elementsOf, gymAccount, loadScreen, renderHook, settle, textOf } from '../harness.mjs';

// Your training log as Settings draws it over `engine`: its rows' words, the Select and the Switch as the section hands
// them their props (a child component is not drawn here), and what the copy holds.
async function drawn(t, engine) {
  const { GymSettingsSection } = await loadScreen('products/gym/settings/GymSettingsSection.jsx');
  const { Select } = await loadScreen('design-system/forms/Select.jsx');
  const { Switch } = await loadScreen('design-system/forms/Switch.jsx');
  const screen = renderHook(t, () => GymSettingsSection(), { live: true });
  await settle();
  const one = (type) => elementsOf(screen.tree).find((item) => item.type === type);
  return {
    screen,
    words: () => textOf(screen.tree?.props.children ?? null),
    select: () => one(Select).props,
    toggle: () => one(Switch).props,
    choose: async (value) => { one(Select).props.onChange(value); await settle(); },
    sound: async (on) => { one(Switch).props.onChange(on); await settle(); },
    unit: async (unit) => {
      elementsOf(screen.tree).find((item) => item.type === 'button' && textOf(item) === unit).props.onClick();
      await settle();
    },
    stored: () => createGymApi(engine).preferences(),
  };
}

async function section(t, preferences, rows = []) {
  const gym = await gymAccount(t, [...(preferences ? [confirmed('prefs', 'prefs', preferences)] : []), ...rows]);
  return { gym, ...await drawn(t, gym.engine) };
}

const RESTING = 'UnitskglbDefault restFor movements on DefaultRest soundA tone and a buzz when rest is upNoteswhat you write for Coach›';

test('the section draws Units, Default rest, Rest sound and the Notes door, and offers the routine editor’s rests', async (t) => {
  t.after(() => spellWeightsIn(KG));
  browserWith();
  const { screen, words, select, toggle } = await section(t, { units: 'kg', restSeconds: 135, restSound: false });
  assert.equal(screen.tree.props.title, 'Your training log');
  assert.equal(words(), RESTING);
  const { value, options, compact, labelledBy } = select();
  assert.deepEqual({ value, compact, labels: options.map((option) => option.label) },
    { value: '135', compact: true, labels: ['Off', '0:30', '1:00', '1:30', '2:00', '2:15', '2:30', '3:00', '4:00', '5:00'] },
    'a stored rest no routine offers is offered where it falls');
  assert.deepEqual({ checked: toggle().checked, label: toggle().label }, { checked: false, label: undefined });
  const named = (id) => textOf(elementsOf(screen.tree).find((item) => item.props.id === id));
  assert.deepEqual([named(labelledBy), named(toggle().labelledBy)], ['Default rest', 'Rest sound'], 'each control is named by its row');
});

test('a fresh copy reads Off and sound on, and a default chosen writes the rest alone, says Saved. for a beat, then rests', async (t) => {
  browserWith();
  const { gym, words, select, choose, stored } = await section(t, null);
  assert.deepEqual([select().value, select().options.map((option) => option.label)],
    ['off', ['Off', '0:30', '1:00', '1:30', '2:00', '2:30', '3:00', '4:00', '5:00']]);
  await choose('90');
  assert.deepEqual(gym.owed(), ['ready write prefs prefs restSeconds']);
  assert.deepEqual(await stored(), { units: 'kg', restSeconds: 90, restSound: true, confirmHaptic: true, confirmSound: false });
  assert.equal(select().value, '90');
  assert.equal(words(), RESTING.replace('For movements on Default', 'Saved.'));
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(words(), RESTING);
  await choose('off');
  assert.deepEqual(gym.owed(), ['ready write prefs prefs restSeconds', 'ready write prefs prefs restSeconds']);
  assert.equal((await stored()).restSeconds, undefined, 'Off is no default rest');
});

test('Rest sound writes the sound alone and says Saved. under its own row', async (t) => {
  browserWith();
  const { gym, words, toggle, sound, stored } = await section(t, { units: 'lb', restSeconds: 120, confirmSound: true });
  t.after(() => spellWeightsIn(KG));
  await sound(false);
  assert.deepEqual(gym.owed(), ['ready write prefs prefs restSound']);
  assert.deepEqual(await stored(), { units: 'lb', restSeconds: 120, restSound: false, confirmHaptic: true, confirmSound: true });
  assert.equal(toggle().checked, false);
  assert.equal(words(), 'UnitskglbA backfill, a correction, a routine target — typed in kg.Default restFor movements on DefaultRest soundSaved.'
    + 'Noteswhat you write for Coach›');
});

test('a default the browser cannot store returns to the stored rest and says so under its row until the next change', async (t) => {
  browserWith();
  const { gym, words, select, choose, stored } = await section(t, { restSeconds: 90 });
  gym.refuseWrites();
  await choose('120');
  assert.equal(select().value, '90');
  assert.equal((await stored()).restSeconds, 90);
  const notSaved = RESTING.replace('For movements on Default', 'That setting didn’t save — this device couldn’t store it.');
  assert.equal(words(), notSaved);
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(words(), notSaved, 'it promises nothing and stays');
});

test('a refusal says its own sentence under the row that was refused', async (t) => {
  browserWith();
  const { gym, words, sound } = await section(t, { restSound: true });
  const commit = gym.engine.commit.bind(gym.engine);
  t.mock.method(gym.engine, 'commit', (scope, build) => commit(scope, (views) => build({ ...views, binding: '["rp_another","B"]' })));
  await sound(false);
  assert.equal(words(), RESTING.replace('A tone and a buzz when rest is up', 'That wasn’t saved — the account on this browser changed.'));
});

test('a units save the device cannot keep reverts to the units the store holds, and says so under Units', async (t) => {
  t.after(() => spellWeightsIn(KG));
  browserWith();
  const { gym, screen, unit, stored } = await section(t, { units: 'kg', restSeconds: 90 });
  await unit(LB);
  assert.equal(weightUnit(), 'lb');
  gym.refuseWrites();
  await unit(KG);
  assert.equal(weightUnit(), 'lb');
  assert.deepEqual(elementsOf(screen.tree).filter((item) => item.type === 'button').map((item) => [textOf(item), item.props['aria-pressed']]),
    [['kg', false], ['lb', true]]);
  assert.equal((await stored()).units, 'lb');
  assert.equal(textOf(screen.tree.props.children), 'UnitskglbA backfill, a correction, a routine target — typed in kg.That setting didn’t save — this device couldn’t store it.'
    + 'Default restFor movements on DefaultRest soundA tone and a buzz when rest is upNoteswhat you write for Coach›');
});

test('while a workout is open, Default rest names the workout that follows it', async (t) => {
  browserWith();
  const startedAt = Date.now() - 10 * 60_000;
  const { words } = await section(t, null, [confirmed('session', 'session_a', { startedAt, plan: { routine: 'Upper A', entries: [{ exerciseId: 'bench-press' }] } })]);
  assert.equal(words(), RESTING.replace('For movements on Default', 'For movements on Default · Upper A follows it'));
});

test('signed out, the section runs on the browser’s own copy and leaves the account’s Notes out', async (t) => {
  browserWith();
  const env = environment();
  env.options.registry = registry;
  const engine = await BrowserSyncEngine.open(env.options);
  t.after(() => engine.close());
  t.mock.method(syncSession, 'getSnapshot', () => ({ engine, ready: true, signedIn: false, account: null, online: true, error: false }));
  assert.equal(engine.getSnapshot().state, 'anon');
  const { words, choose, stored } = await drawn(t, engine);
  assert.equal(words(), 'UnitskglbDefault restFor movements on DefaultRest soundA tone and a buzz when rest is up');
  await choose('300');
  await until(() => engine.device.activeReplica.entries().length === 1);
  assert.equal((await stored()).restSeconds, 300);
  assert.deepEqual(engine.device.activeReplica.entries().map(({ intent }) => intent.d.map(({ t: type, f }) => [type, Object.keys(f)])),
    [[['prefs', ['restSeconds']]]]);
});

test('another tab’s sign-out leaves the section empty until the shell catches up, never the browser’s signed-out units', async (t) => {
  t.after(() => spellWeightsIn(KG));
  browserWith();
  const { gym, screen, select } = await section(t, { units: 'lb' });
  assert.equal(select().value, 'off');
  gym.engine.setOnline(false);
  await gym.engine.beginSignOut();
  assert.equal((await gym.engine.finishSignOut({ choice: 'keep' })).complete, true);
  await settle();
  assert.deepEqual([gym.engine.getSnapshot().state, screen.tree], ['anon', null]);
  assert.deepEqual(gym.engine.device.activeReplica.outbox, []);
});
