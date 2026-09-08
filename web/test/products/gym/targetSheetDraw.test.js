import test from 'node:test';
import assert from 'node:assert/strict';

import { NEW_ROUTINE_ID } from '../../../src/products/gym/log.js';
import { OPEN_LINE, REPS_BAND, SETS_BAND, VARIES_PLACEHOLDER } from '../../../src/products/gym/routines.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, settle, textOf } from './harness.mjs';

const CATALOG = [
  { id: 'back-squat', name: 'Back Squat', equipment: 'barbell' },
  { id: 'chin-up', name: 'Chin-up', equipment: 'bodyweight' },
];
const LOG = roomLog({ catalog: CATALOG });

// Lower A / Back Squat, the fixture every surface draws: 60×5 · 80×5 · 90×3 · 100×1 · 80×5.
const RAMP = {
  exerciseId: 'back-squat',
  sets: [
    { reps: 5, weightKg: 60 }, { reps: 5, weightKg: 80 }, { reps: 3, weightKg: 90 },
    { reps: 1, weightKg: 100 }, { reps: 5, weightKg: 80 },
  ],
  restSeconds: 180,
};

// A child component is not rendered by the harness, so the parent's tree holds it as an element and
// its props are what the parent handed it: that is how one screen is driven through the next.
const handed = (tree, prop) => elementsOf(tree)
  .find((each) => typeof each.type === 'function' && each.props != null && prop in each.props);
const field = (tree, name) => elementsOf(tree).find((each) => each.props?.label === name || each.props?.ariaLabel === name);
const drawn = (tree, className) => findByClass(tree, className).map(textOf);
const refusals = (tree) => elementsOf(tree)
  .filter((each) => each.props?.error != null)
  .map((each) => [each.props.label ?? each.props.ariaLabel, each.props.error]);
const typed = (value) => ({ target: { value } });
const type = (tree, name, value) => field(tree, name).props.onChange(typed(value));
const rows = (tree) => findByClass(tree, 'gym-ladder-row')
  .filter((row) => !row.props.className.includes('is-add'))
  .map((row, index) => [field(row, `Set ${index + 1} reps`).props.value, field(row, `Set ${index + 1} load`).props.value]);
const commit = (tree) => {
  const button = elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'Button');
  return button.props.disabled ? null : button.props.children;
};
const fill = (t, tree) => {
  const menu = handed(tree, 'items');
  return { items: menu.props.items, opener: textOf(findByClass(renderHook(t, () => menu.type(menu.props)).tree, 'gym-fill-open')[0]) };
};

// The sheet is reached the way a lifter reaches it: a new routine, a movement added, its row tapped.
async function openEditor(t, exerciseId = 'back-squat') {
  browserWith();
  const { RoutineEditor } = await loadScreen('products/gym/Routines.jsx');
  const editor = renderHook(t, () => RoutineEditor({ id: NEW_ROUTINE_ID, log: LOG }));
  await settle();
  elementsOf(editor.tree).find((each) => textOf(each.props?.children) === '+ Add movement').props.onClick();
  handed(editor.tree, 'onPick').props.onPick(exerciseId);
  return editor;
}

function sheetOf(t, editor) {
  handed(editor.tree, 'onTarget').props.onTarget(0);
  const sheet = handed(editor.tree, 'neverLogged');
  return renderHook(t, () => sheet.type(sheet.props));
}

async function openSheet(t, exerciseId = 'back-squat') {
  const editor = await openEditor(t, exerciseId);
  const sheet = sheetOf(t, editor);
  assert.equal(handed(editor.tree, 'neverLogged').props.movement, exerciseId === 'chin-up' ? 'Chin-up' : 'Back Squat');
  return sheet;
}

// The ramp, set through the sheet and the sheet reopened on it: the head reads the rows.
async function openRamp(t) {
  const editor = await openEditor(t);
  handed(editor.tree, 'onTarget').props.onTarget(0);
  handed(editor.tree, 'neverLogged').props.onSet(RAMP);
  return sheetOf(t, editor);
}

test('an open line: the sentence, the two head fields inert, no ladder — and a count brings the ladder', async (t) => {
  const sheet = await openSheet(t);
  assert.deepEqual(drawn(sheet.tree, 'gym-open-line'), [OPEN_LINE]);
  assert.deepEqual(refusals(sheet.tree), []);
  assert.deepEqual(findByClass(sheet.tree, 'gym-ladder'), []);
  assert.equal(findByClass(sheet.tree, 'gym-target-head')[0].props.disabled, true);
  assert.equal(commit(sheet.tree), 'Set · open');

  type(sheet.tree, 'Sets', '3');
  assert.deepEqual(drawn(sheet.tree, 'gym-open-line'), []);
  assert.equal(findByClass(sheet.tree, 'gym-target-head')[0].props.disabled, false);
  assert.deepEqual(rows(sheet.tree), [['', ''], ['', ''], ['', '']]);
  assert.equal(field(sheet.tree, 'Reps').props.placeholder, 'max');
  assert.equal(field(sheet.tree, 'Weight').props.placeholder, 'last time');
  assert.equal(commit(sheet.tree), 'Set · 3 × max');

  // A refusal is drawn under the row that carries the fault, and nowhere else.
  type(sheet.tree, 'Set 2 reps', '400');
  assert.deepEqual(refusals(sheet.tree), [['Set 2 reps', REPS_BAND]]);
  assert.equal(commit(sheet.tree), null);
  type(sheet.tree, 'Set 2 reps', '8');
  assert.deepEqual(refusals(sheet.tree), []);

  // The head writes every row.
  type(sheet.tree, 'Reps', '5');
  type(sheet.tree, 'Weight', '80');
  assert.deepEqual(rows(sheet.tree), [['5', '80'], ['5', '80'], ['5', '80']]);
  assert.equal(commit(sheet.tree), 'Set · 3 × 5 · 80');

  // Clearing Sets hides the ladder without discarding it, and retyping the count brings it back.
  type(sheet.tree, 'Sets', '');
  assert.deepEqual(drawn(sheet.tree, 'gym-open-line'), [OPEN_LINE]);
  assert.deepEqual(findByClass(sheet.tree, 'gym-ladder'), []);
  type(sheet.tree, 'Sets', '3');
  assert.deepEqual(rows(sheet.tree), [['5', '80'], ['5', '80'], ['5', '80']]);
});

test('the ramp fixture: head 5 · varies · varies, five rows, commit `Set · 5 sets`, and fourteen words of chrome', async (t) => {
  const sheet = await openRamp(t);
  assert.equal(field(sheet.tree, 'Sets').props.value, '5');
  assert.equal(field(sheet.tree, 'Reps').props.value, '');
  assert.equal(field(sheet.tree, 'Reps').props.placeholder, VARIES_PLACEHOLDER);
  assert.equal(field(sheet.tree, 'Weight').props.value, '');
  assert.equal(field(sheet.tree, 'Weight').props.placeholder, VARIES_PLACEHOLDER);
  assert.deepEqual(rows(sheet.tree), [['5', '60'], ['5', '80'], ['3', '90'], ['1', '100'], ['5', '80']]);
  assert.equal(commit(sheet.tree), 'Set · 5 sets');
  assert.deepEqual(drawn(sheet.tree, 'gym-open-line'), []);

  const chrome = [
    ...elementsOf(sheet.tree).filter((each) => each.type === 'h3').map(textOf),
    ...['Sets', 'Reps', 'Weight'].map((name) => field(sheet.tree, name).props.label),
    fill(t, sheet.tree).opener,
    ...drawn(sheet.tree, 'gym-ladder-add'),
    commit(sheet.tree),
  ];
  assert.deepEqual(chrome, ['Every set', 'Set by set', 'Sets', 'Reps', 'Weight', 'Fill', 'Add set', 'Set · 5 sets']);
  assert.equal(chrome.join(' ').split(/[\s·]+/).filter(Boolean).length, 14);

  // Typing over `varies` writes every row again.
  type(sheet.tree, 'Reps', '5');
  assert.deepEqual(rows(sheet.tree).map(([reps]) => reps), ['5', '5', '5', '5', '5']);
  assert.equal(field(sheet.tree, 'Reps').props.value, '5');
});

test('Fill: Ramp up interpolates between the two ends, and Match set 1 is the way back to a straight scheme', async (t) => {
  const sheet = await openSheet(t);
  type(sheet.tree, 'Sets', '5');
  assert.equal(fill(t, sheet.tree).items[0].disabled, true, 'nothing to ramp between while the ends agree');
  type(sheet.tree, 'Set 1 reps', '5');
  type(sheet.tree, 'Set 1 load', '60');
  type(sheet.tree, 'Set 5 reps', '1');
  type(sheet.tree, 'Set 5 load', '100');
  const { items } = fill(t, sheet.tree);
  assert.deepEqual(items.map((item) => [item.label, item.disabled]), [['Ramp up', false], ['Match set 1', false]]);
  items[0].run();
  assert.deepEqual(rows(sheet.tree), [['5', '60'], ['4', '70'], ['3', '80'], ['2', '90'], ['1', '100']]);
  assert.equal(commit(sheet.tree), 'Set · 5 sets');

  fill(t, sheet.tree).items[1].run();
  assert.deepEqual(rows(sheet.tree), [['5', '60'], ['5', '60'], ['5', '60'], ['5', '60'], ['5', '60']]);
  assert.equal(commit(sheet.tree), 'Set · 5 × 5 · 60');
});

test('Add set copies the row above; deleting the last row lands on the open line; twenty is the ceiling', async (t) => {
  const sheet = await openRamp(t);
  findByClass(sheet.tree, 'gym-ladder-add')[0].props.onClick();
  assert.equal(field(sheet.tree, 'Sets').props.value, '6');
  assert.deepEqual(rows(sheet.tree)[5], ['5', '80']);

  // Sets grows the same way: 6 → 7 copies the sixth.
  type(sheet.tree, 'Sets', '7');
  assert.deepEqual(rows(sheet.tree)[6], ['5', '80']);
  assert.equal(rows(sheet.tree).length, 7);

  for (let index = 6; index > 0; index -= 1) findByClass(sheet.tree, 'gym-ladder-drop')[index].props.onClick();
  assert.deepEqual(rows(sheet.tree), [['5', '60']]);
  assert.equal(field(sheet.tree, 'Sets').props.value, '1');
  assert.equal(commit(sheet.tree), 'Set · 1 × 5 · 60');
  findByClass(sheet.tree, 'gym-ladder-drop')[0].props.onClick();
  assert.equal(field(sheet.tree, 'Sets').props.value, '');
  assert.deepEqual(drawn(sheet.tree, 'gym-open-line'), [OPEN_LINE]);
  assert.deepEqual(findByClass(sheet.tree, 'gym-ladder'), []);

  type(sheet.tree, 'Sets', '20');
  assert.equal(rows(sheet.tree).length, 20);
  findByClass(sheet.tree, 'gym-ladder-add')[0].props.onClick();
  assert.equal(rows(sheet.tree).length, 20);
  assert.deepEqual(drawn(sheet.tree, 'gym-ladder-refusal'), [SETS_BAND]);
  assert.equal(commit(sheet.tree), null);
  type(sheet.tree, 'Set 1 reps', '8');
  assert.deepEqual(drawn(sheet.tree, 'gym-ladder-refusal'), []);
});

test('the ± is drawn on a bodyweight movement’s load fields only, named `Flip the sign — band-assisted`', async (t) => {
  const barbell = await openSheet(t);
  type(barbell.tree, 'Sets', '3');
  assert.deepEqual(findByClass(barbell.tree, 'gym-target-sign'), []);

  const sheet = await openSheet(t, 'chin-up');
  type(sheet.tree, 'Sets', '3');
  const signs = findByClass(sheet.tree, 'gym-target-sign');
  assert.equal(signs.length, 4, 'the head and the three rows');
  for (const sign of signs) {
    assert.equal(sign.props['aria-label'], 'Flip the sign — band-assisted');
    assert.equal(textOf(sign), '±');
    assert.equal(sign.props.type, 'button');
  }
  type(sheet.tree, 'Reps', '8');
  type(sheet.tree, 'Weight', '20');
  findByClass(sheet.tree, 'gym-target-sign')[0].props.onClick();
  assert.deepEqual(rows(sheet.tree), [['8', '-20'], ['8', '-20'], ['8', '-20']]);
  assert.equal(field(sheet.tree, 'Weight').props.value, '-20');
  findByClass(sheet.tree, 'gym-target-sign')[2].props.onClick();
  assert.deepEqual(rows(sheet.tree), [['8', '-20'], ['8', '20'], ['8', '-20']]);
  assert.equal(field(sheet.tree, 'Weight').props.placeholder, VARIES_PLACEHOLDER);
  assert.deepEqual(refusals(sheet.tree), []);
});

test('the sheet owns the sentence; the list never draws a copy, open row or not', async (t) => {
  const editor = await openEditor(t);
  // One open row, no sheet: the row names itself `open` and the list says nothing more.
  assert.deepEqual(drawn(editor.tree, 'gym-open-line'), []);

  // The row is tapped. The sheet is the whole of what is said about that line.
  handed(editor.tree, 'onTarget').props.onTarget(0);
  assert.deepEqual(drawn(editor.tree, 'gym-open-line'), []);
  const sheet = handed(editor.tree, 'neverLogged');
  assert.equal(sheet.props.equipment, 'barbell');
  assert.deepEqual(drawn(renderHook(t, () => sheet.type(sheet.props)).tree, 'gym-open-line'), [OPEN_LINE]);

  // The sheet closes with nothing set: the row is still open, and the list still draws no copy.
  sheet.props.onClose();
  assert.deepEqual(drawn(editor.tree, 'gym-open-line'), []);

  // And a line the sheet named is not open any more, so nobody draws it; the row reads its readout.
  handed(editor.tree, 'onTarget').props.onTarget(0);
  handed(editor.tree, 'neverLogged').props.onSet(RAMP);
  assert.deepEqual(drawn(editor.tree, 'gym-open-line'), []);
  assert.deepEqual(handed(editor.tree, 'onTarget').props.entries, [RAMP]);
  const list = handed(editor.tree, 'onTarget');
  assert.deepEqual(drawn(renderHook(t, () => list.type(list.props)).tree, 'gym-entry-target'), ['5 × 1–5 · 60–100']);
});
