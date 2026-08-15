// The settings section, driven for real (harness.mjs) with the api injected. Every change is a
// whole-document PUT redrawn off what comes back, and a refusal reverts to the document the store
// last confirmed. What is pinned is the one way that revert could lose a landed write: rows move
// faster than round trips, and a reply that is stale for the SCREEN is still the store's answer.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GymError } from '../../../../src/products/gym/gymApi.js';
import { KG, LB, spellWeightsIn, weightUnit } from '../../../../src/products/gym/units.js';
import { browserWith, elementsOf, loadScreen, renderHook, settle } from '../harness.mjs';

// A store that answers each PUT with the document it was sent, when the test releases it — so replies
// can be made to land in any order — and refuses the one the test names.
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

// Units flipped to lb — landed — then a rest target the store refuses. The refusal must revert to
// the document WITH lb in it: the units reply came back after the rest write was sent, and a screen
// that ignored it as stale reverted to kilograms off-screen and spelled every weight in them again.
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

  // Two rows, one round trip apart and neither answered yet.
  chooser(screen.tree, UNITS).props.onPick(LB);
  chooser(screen.tree, REST_CHOICES).props.onPick(180);
  assert.deepEqual(store.puts.map((put) => put.document), [
    { units: 'lb', restSeconds: 90, restSound: true, confirmHaptic: true, confirmSound: false },
    { units: 'lb', restSeconds: 180, restSound: true, confirmHaptic: true, confirmSound: false },
  ]);
  assert.equal(weightUnit(), 'lb');

  // The units reply lands — stale for the screen, which has moved on to the rest write, but the
  // store's confirmation that lb is what it holds.
  store.release(0);
  await settle();
  // Then the rest write is refused: the screen goes back to what the store confirmed, which is lb.
  store.release(1, { refuse: new GymError(400, 'rest must be between 15 and 600 seconds', 'rest-target') });
  await settle();

  assert.equal(chooser(screen.tree, UNITS).props.value, 'lb');
  assert.equal(chooser(screen.tree, REST_CHOICES).props.value, 90);
  assert.equal(weightUnit(), 'lb');
  const refusal = elementsOf(screen.tree).find((each) => each.props.children === 'rest must be between 15 and 600 seconds');
  assert.notEqual(refusal, undefined);
});

// The other order — the newer reply lands first — must not let the older one move the confirmed
// document backwards: the store's later word stands.
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

  // A third write refused reverts to 180 — the last the store confirmed — and never to 120.
  chooser(screen.tree, REST_CHOICES).props.onPick(300);
  store.release(2, { refuse: new GymError(503, '') });
  await settle();
  assert.equal(chooser(screen.tree, REST_CHOICES).props.value, 180);
  assert.equal(weightUnit(), 'kg');
});
