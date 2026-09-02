import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KEYS, LOGGER_REPS_MAX, LOGGER_REPS_MIN, NOT_A_NUMBER, ONE_DECIMAL, OVER_MAX_LOAD, REPS_BAND,
} from '../../../../src/products/gym/logger/entry.js';
import { browserWith, elementsOf, loadScreen, renderHook, textOf } from '../harness.mjs';

// The four the rack refuses, in the bytes 15-the-routine.md pins, with THIS screen's band.
const PINNED = ['One decimal point only.', 'That is not a number yet.', 'Over 500 kg — check the number.',
  'Whole reps, 1 to 99.'];

const typeInto = (drawn, keys) => {
  for (const key of keys) {
    const pad = elementsOf(drawn.tree).find((each) => each.props?.className?.startsWith('gym-key') && each.props?.children === key);
    assert.notEqual(pad, undefined, `no ${key} key`);
    pad.props.onClick();
  }
};

const messageOf = (drawn) => textOf(elementsOf(drawn.tree)
  .find((each) => each.props?.className?.startsWith('gym-keypad-message')));

const inert = (drawn) => elementsOf(drawn.tree)
  .find((each) => each.props?.className?.startsWith('gym-keypad-set')).props.className.includes('is-inert');

test('the rack keypad draws the four refusals, and the band it names is the logger’s 1 to 99', async (t) => {
  browserWith();
  assert.deepEqual([ONE_DECIMAL, NOT_A_NUMBER, OVER_MAX_LOAD, REPS_BAND], PINNED);
  assert.deepEqual([LOGGER_REPS_MIN, LOGGER_REPS_MAX], [1, 99]);
  const { Keypad } = await loadScreen('products/gym/logger/Keypad.jsx');
  const open = (mode, current) => renderHook(t, () => Keypad({ mode, current, onCommit: () => {}, onCancel: () => {} }));

  const weight = open('weight', 100);
  typeInto(weight, ['1', ',', '2', ',', '5']);
  assert.equal(messageOf(weight), ONE_DECIMAL);
  assert.equal(inert(weight), true, 'a refused buffer commits nothing');

  const signed = open('weight', 100);
  typeInto(signed, ['5', '±', '±']);
  assert.equal(messageOf(signed), 'kg', 'a valid weight reads its unit and no hint');

  const over = open('weight', 100);
  typeInto(over, ['5', '0', '1']);
  assert.equal(messageOf(over), OVER_MAX_LOAD);
  assert.equal(inert(over), true);

  // A decimal point and nothing else: one point, so it is not the sentence above, and no number yet.
  const notYet = open('weight', 100);
  typeInto(notYet, [',']);
  assert.equal(messageOf(notYet), NOT_A_NUMBER);
  assert.equal(inert(notYet), true);
  typeInto(notYet, ['5']);
  assert.equal(messageOf(notYet), 'kg');

  const reps = open('reps', 5);
  typeInto(reps, ['1', '0', '0']);
  assert.equal(messageOf(reps), REPS_BAND);
  assert.equal(inert(reps), true);
  typeInto(reps, ['9']);
  assert.equal(messageOf(reps), REPS_BAND, '1009 is over the band too');
  // The two keys a whole rep count has no use for are stood down on this mode.
  for (const key of [',', '±']) {
    const stood = elementsOf(reps.tree).find((each) => each.props?.className?.startsWith('gym-key') && each.props?.children === key);
    assert.equal(stood.props.className, 'gym-key is-inert', key);
  }
});

test('the fix sheet is at the rack, so both its numerals raise the keypad', async (t) => {
  browserWith();
  const { FixSheet } = await loadScreen('products/gym/FixSheet.jsx');
  const { Keypad } = await loadScreen('products/gym/logger/Keypad.jsx');
  const set = { id: 'set_1', exerciseId: 'back-squat', setNumber: 2, weightKg: 100, reps: 5, kind: 'working' };
  const drawn = renderHook(t, () => FixSheet({
    set, movement: { id: 'back-squat', name: 'Back Squat' }, session: null,
    onSave: () => {}, onDelete: () => {}, onClose: () => {},
  }));
  const padOf = () => elementsOf(drawn.tree).find((each) => each.type === Keypad);
  const tap = (className) => elementsOf(drawn.tree).find((each) => each.props?.className === className).props.onClick();

  assert.equal(padOf(), undefined, 'the sheet opens on its numbers, not on a pad');
  tap('gym-fix-weight');
  assert.equal(padOf().props.mode, 'weight');
  assert.equal(padOf().props.current, 100);
  assert.equal(padOf().props.editing, true);
  padOf().props.onCancel();

  tap('gym-fix-value');
  assert.equal(padOf().props.mode, 'reps');
  assert.equal(padOf().props.current, 5);
});

test('the rack keypad names both its glyphs — ± `Flip the sign — band-assisted`, ⌫ `Delete` — and no digit', async (t) => {
  browserWith();
  const { Keypad } = await loadScreen('products/gym/logger/Keypad.jsx');
  const drawn = renderHook(t, () => Keypad({ mode: 'weight', current: 100, onCommit: () => {}, onCancel: () => {} }));
  const keys = elementsOf(drawn.tree).filter((each) => each.props?.className?.split(' ')[0] === 'gym-key');
  assert.deepEqual(keys.map((each) => each.props.children), KEYS);

  // Two of the pad's buttons are glyphs and each is named; the ten digits and the decimal separator
  // read as themselves, because a digit that says a word out loud is a worse pad than a silent one.
  assert.deepEqual(
    elementsOf(drawn.tree)
      .filter((each) => each.type === 'button' && each.props['aria-label'] != null)
      .map((each) => [each.props.children, each.props['aria-label']]),
    [['\u00b1', 'Flip the sign — band-assisted'], ['\u232b', 'Delete']],
  );
  assert.equal(keys.filter((each) => each.props['aria-label'] == null).length, 11);

  // Each name is on the control that acts, and pressing it acts.
  const echo = () => textOf(elementsOf(drawn.tree).find((each) => each.props?.className?.startsWith('gym-keypad-echo')));
  const sign = keys.find((each) => each.props.children === '\u00b1');
  sign.props.onClick();
  assert.equal(echo(), '\u2212100', 'band-assisted, drawn with the minus the echo draws');
  sign.props.onClick();
  assert.equal(echo(), '100');

  const back = elementsOf(drawn.tree).find((each) => each.props?.className === 'gym-keypad-back');
  back.props.onClick();
  assert.equal(echo(), '10', 'the named key deletes');

  // Off this mode the sign key is stood down, and a stood-down key is still named rather than a glyph.
  const reps = renderHook(t, () => Keypad({ mode: 'reps', current: 5, onCommit: () => {}, onCancel: () => {} }));
  const stood = elementsOf(reps.tree).find((each) => each.props?.className?.startsWith('gym-key') && each.props?.children === '±');
  assert.equal(stood.props.className, 'gym-key is-inert');
  assert.equal(stood.props['aria-label'], 'Flip the sign — band-assisted');
  assert.equal(
    elementsOf(reps.tree).find((each) => each.props?.className === 'gym-keypad-back').props['aria-label'],
    'Delete',
  );
});

test('the rack keypad’s scrim cancels — on the fix sheet and on the backfill form, valid buffer or not', async (t) => {
  browserWith();
  const { Keypad } = await loadScreen('products/gym/logger/Keypad.jsx');
  // 12-native-idiom's vocabulary rule: an outside tap is one word in this room, and every other
  // scrim in it — and both phones — spends that word on dismissal.
  const scrim = (drawn) => elementsOf(drawn.tree).find((each) => each.props?.className === 'gym-sheet-catch');

  const said = [];
  const edited = renderHook(t, () => Keypad({
    mode: 'weight', current: 100, onCommit: (value) => said.push(['commit', value]), onCancel: () => said.push(['cancel']),
  }));
  typeInto(edited, ['1', '2', '5']);
  assert.equal(inert(edited), false, 'a valid buffer — the state the scrim used to write');
  scrim(edited).props.onClick();
  assert.deepEqual(said, [['cancel']], 'the scrim keeps the typed number out of the draft');

  const refused = [];
  const invalid = renderHook(t, () => Keypad({
    mode: 'reps', current: 5, onCommit: (value) => refused.push(['commit', value]), onCancel: () => refused.push(['cancel']),
  }));
  typeInto(invalid, ['1', '0', '0']);
  assert.equal(inert(invalid), true);
  scrim(invalid).props.onClick();
  assert.deepEqual(refused, [['cancel']], 'the refused buffer gets the exit it had none of');

  // One handler, so the two screens the pad serves — the fix sheet and the backfill form — cannot
  // read the outside tap differently.
  const away = () => {};
  const wired = renderHook(t, () => Keypad({ mode: 'weight', current: 100, onCommit: () => {}, onCancel: away }));
  assert.equal(scrim(wired).props.onClick, away);
  assert.equal(
    elementsOf(wired.tree).find((each) => each.props?.className === 'gym-keypad-cancel').props.onClick,
    away,
    'the scrim and the Cancel button are the same act',
  );
});
