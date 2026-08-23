import test from 'node:test';
import assert from 'node:assert/strict';

import { GymError } from '../../../../src/products/gym/gymApi.js';
import { KG, LB, spellWeightsIn, weightUnit } from '../../../../src/products/gym/units.js';
import { browserWith, elementsOf, loadScreen, renderHook, settle } from '../harness.mjs';

function preferencesStore(initial) {
  const puts = [];
  return {
    puts,
    release: (index, { refuse = null } = {}) => puts[index].settle(refuse),
    api: {
      async preferences() { return initial; },
      async sessions() { return []; },
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

const chooser = (tree, options) => elementsOf(tree)
  .find((each) => typeof each.props.onPick === 'function' && each.props.options === options);

test('a landed write moves what a later refusal reverts to, even when its reply arrived after the next write went', async (t) => {
  t.after(() => spellWeightsIn(KG));
  browserWith();
  const store = preferencesStore({ units: 'kg', restSeconds: 90 });
  const { GymSettingsSection } = await loadScreen('products/gym/settings/GymSettingsSection.jsx');
  const { UNITS } = await import('../../../../src/products/gym/units.js');
  const { REST_CHOICES } = await import('../../../../src/products/gym/settings/preferences.js');

  const screen = renderHook(t, () => GymSettingsSection({ api: store.api }));
  await settle();
  assert.equal(chooser(screen.tree, UNITS).props.value, 'kg');

  chooser(screen.tree, UNITS).props.onPick(LB);
  chooser(screen.tree, REST_CHOICES).props.onPick(180);
  assert.deepEqual(store.puts.map((put) => put.document), [
    { units: 'lb', restSeconds: 90, restSound: true, confirmHaptic: true, confirmSound: false },
    { units: 'lb', restSeconds: 180, restSound: true, confirmHaptic: true, confirmSound: false },
  ]);
  assert.equal(weightUnit(), 'lb');

  store.release(0);
  await settle();
  store.release(1, { refuse: new GymError(400, 'rest must be between 15 and 600 seconds', 'rest-target') });
  await settle();

  assert.equal(chooser(screen.tree, UNITS).props.value, 'lb');
  assert.equal(chooser(screen.tree, REST_CHOICES).props.value, 90);
  assert.equal(weightUnit(), 'lb');
  const refusal = elementsOf(screen.tree).find((each) => each.props.children === 'rest must be between 15 and 600 seconds');
  assert.notEqual(refusal, undefined);
});

test('a reply older than one already confirmed does not move what a refusal reverts to', async (t) => {
  t.after(() => spellWeightsIn(KG));
  browserWith();
  const store = preferencesStore({ units: 'kg', restSeconds: 90 });
  const { GymSettingsSection } = await loadScreen('products/gym/settings/GymSettingsSection.jsx');
  const { UNITS } = await import('../../../../src/products/gym/units.js');
  const { REST_CHOICES } = await import('../../../../src/products/gym/settings/preferences.js');

  const screen = renderHook(t, () => GymSettingsSection({ api: store.api }));
  await settle();

  chooser(screen.tree, REST_CHOICES).props.onPick(120);
  chooser(screen.tree, REST_CHOICES).props.onPick(180);
  store.release(1);
  await settle();
  store.release(0);
  await settle();
  assert.equal(chooser(screen.tree, REST_CHOICES).props.value, 180);

  chooser(screen.tree, REST_CHOICES).props.onPick(300);
  store.release(2, { refuse: new GymError(503, '') });
  await settle();
  assert.equal(chooser(screen.tree, REST_CHOICES).props.value, 180);
  assert.equal(weightUnit(), 'kg');
});
