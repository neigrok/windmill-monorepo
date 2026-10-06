import test from 'node:test';
import assert from 'node:assert/strict';

import { KG, LB, spellWeightsIn, weightUnit } from '../../../../src/products/gym/units.js';
import { createGymApi } from '../../../../src/products/gym/gymSync.js';
import { browserWith, confirmed, elementsOf, gymAccount, loadScreen, renderHook, settle, textOf } from '../harness.mjs';

async function section(t, preferences) {
  const gym = await gymAccount(t, [confirmed('prefs', 'prefs', preferences)]);
  const { GymSettingsSection } = await loadScreen('products/gym/settings/GymSettingsSection.jsx');
  const screen = renderHook(t, () => GymSettingsSection(), { live: true });
  await settle();
  const choose = async (unit) => {
    elementsOf(screen.tree).find((item) => item.type === 'button' && textOf(item) === unit).props.onClick();
    await settle();
  };
  const pressed = () => elementsOf(screen.tree).filter((item) => item.type === 'button').map((item) => [textOf(item), item.props['aria-pressed']]);
  return { gym, screen, choose, pressed, stored: () => createGymApi(gym.engine).preferences() };
}

test('units are the only preference controls and a save preserves every native preference', async (t) => {
  t.after(() => spellWeightsIn(KG));
  browserWith();
  const { gym, screen, choose, pressed, stored } = await section(t, { units: 'kg', restSeconds: 135, restSound: false, confirmHaptic: false, confirmSound: true });
  assert.equal(screen.tree.props.title, 'Your training log');
  assert.equal(textOf(screen.tree.props.children), 'UnitskglbNoteswhat you write for Coach›');
  assert.deepEqual(pressed(), [['kg', true], ['lb', false]]);
  await choose(LB);
  assert.deepEqual(gym.owed(), ['ready write prefs prefs units']);
  assert.deepEqual(await stored(), { units: 'lb', restSeconds: 135, restSound: false, confirmHaptic: false, confirmSound: true });
  assert.equal(weightUnit(), 'lb');
  assert.equal(textOf(screen.tree.props.children), 'UnitskglbA backfill, a correction, a routine target — typed in kg.Noteswhat you write for Coach›');
});

test('a units save the device cannot keep reverts to the units the store holds, and says so', async (t) => {
  t.after(() => spellWeightsIn(KG));
  browserWith();
  const { gym, screen, choose, pressed, stored } = await section(t, { units: 'kg', restSeconds: 90 });
  await choose(LB);
  gym.refuseWrites();
  await choose(KG);
  assert.equal(weightUnit(), 'lb');
  assert.deepEqual(pressed(), [['kg', false], ['lb', true]]);
  assert.equal((await stored()).units, 'lb');
  assert.equal(textOf(screen.tree.props.children),
    'UnitskglbA backfill, a correction, a routine target — typed in kg.Noteswhat you write for Coach›that setting didn’t save — the log didn’t answer. Try again in a moment');
});
