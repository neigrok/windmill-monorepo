import test from 'node:test';
import assert from 'node:assert/strict';

import { GymError } from '../../../../src/products/gym/gymApi.js';
import { KG, LB, spellWeightsIn, weightUnit } from '../../../../src/products/gym/units.js';
import { browserWith, elementsOf, loadScreen, renderHook, settle, textOf } from '../harness.mjs';

function preferencesStore(initial) {
  const puts = [];
  return {
    puts,
    release: (index, { refuse = null } = {}) => puts[index].settle(refuse),
    api: {
      async preferences() { return initial; },
      async sessions() { return []; },
      async notes() { return []; },
      async bodyweight() { return { entries: [], latest: null }; },
      savePreferences(document) {
        return new Promise((resolve, reject) => {
          puts.push({
            document,
            settle: (refuse) => (refuse ? reject(refuse) : resolve(document)),
          });
        });
      },
    },
  };
}

test('units are the only preference controls and a save preserves every native preference', async (t) => {
  t.after(() => spellWeightsIn(KG));
  browserWith();
  const store = preferencesStore({ units: 'kg', restSeconds: 135, restSound: false, confirmHaptic: false, confirmSound: true });
  const { GymSettingsSection } = await loadScreen('products/gym/settings/GymSettingsSection.jsx');
  const screen = renderHook(t, () => GymSettingsSection({ api: store.api }));
  await settle();
  assert.equal(screen.tree.props.title, 'Your training log');
  assert.equal(textOf(screen.tree.props.children), 'UnitskglbNoteswhat you write for Coach›');
  assert.deepEqual(elementsOf(screen.tree).filter((item) => item.type === 'button').map((item) => [textOf(item), item.props['aria-pressed']]),
    [['kg', true], ['lb', false]]);
  const pounds = elementsOf(screen.tree).find((item) => item.type === 'button' && textOf(item) === 'lb');
  pounds.props.onClick();
  assert.deepEqual(store.puts.map((put) => put.document), [
    { units: 'lb', restSeconds: 135, restSound: false, confirmHaptic: false, confirmSound: true },
  ]);
  store.release(0);
  await settle();
  assert.equal(weightUnit(), 'lb');
  assert.equal(textOf(screen.tree.props.children), 'UnitskglbA backfill, a correction, a routine target — typed in kg.Noteswhat you write for Coach›');
});

test('an earlier confirmed units write supplies the rollback after a newer write fails', async (t) => {
  t.after(() => spellWeightsIn(KG));
  browserWith();
  const store = preferencesStore({ units: 'kg', restSeconds: 90 });
  const { GymSettingsSection } = await loadScreen('products/gym/settings/GymSettingsSection.jsx');
  const screen = renderHook(t, () => GymSettingsSection({ api: store.api }));
  await settle();
  const choose = (unit) => elementsOf(screen.tree).find((item) => item.type === 'button' && textOf(item) === unit).props.onClick();
  choose(LB);
  choose(KG);
  assert.deepEqual(store.puts.map((put) => put.document), [
    { units: 'lb', restSeconds: 90, restSound: true, confirmHaptic: true, confirmSound: false },
    { units: 'kg', restSeconds: 90, restSound: true, confirmHaptic: true, confirmSound: false },
  ]);
  store.release(0);
  await settle();
  store.release(1, { refuse: new GymError(503, 'temporarily unavailable') });
  await settle();
  assert.equal(weightUnit(), 'lb');
  assert.deepEqual(elementsOf(screen.tree).filter((item) => item.type === 'button').map((item) => [textOf(item), item.props['aria-pressed']]),
    [['kg', false], ['lb', true]]);
  assert.equal(textOf(screen.tree.props.children), 'UnitskglbA backfill, a correction, a routine target — typed in kg.Noteswhat you write for Coach›temporarily unavailable');
});

test('a stale reply does not replace the latest confirmed units used for rollback', async (t) => {
  t.after(() => spellWeightsIn(KG));
  browserWith();
  const store = preferencesStore({ units: 'kg', restSeconds: 90 });
  const { GymSettingsSection } = await loadScreen('products/gym/settings/GymSettingsSection.jsx');
  const screen = renderHook(t, () => GymSettingsSection({ api: store.api }));
  await settle();
  const choose = (unit) => elementsOf(screen.tree).find((item) => item.type === 'button' && textOf(item) === unit).props.onClick();
  choose(LB);
  choose(KG);
  store.release(1);
  await settle();
  store.release(0);
  await settle();
  choose(LB);
  store.release(2, { refuse: new GymError(503, '') });
  await settle();
  assert.deepEqual(elementsOf(screen.tree).filter((item) => item.type === 'button').map((item) => [textOf(item), item.props['aria-pressed']]),
    [['kg', true], ['lb', false]]);
  assert.equal(weightUnit(), 'kg');
});
