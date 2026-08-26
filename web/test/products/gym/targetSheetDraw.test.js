import test from 'node:test';
import assert from 'node:assert/strict';

import { NEW_ROUTINE_ID } from '../../../src/products/gym/log.js';
import { NAME_SETS_FIRST, OPEN_LINE } from '../../../src/products/gym/routines.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, settle, textOf } from './harness.mjs';

const CATALOG = [{ id: 'back-squat', name: 'Back Squat' }];
const LOG = { catalog: CATALOG, summaries: [], say: () => {}, createMovement: async () => null };

// A child component is not rendered by the harness, so the parent's tree holds it as an element and
// its props are what the parent handed it: that is how one screen is driven through the next.
const handed = (tree, prop) => elementsOf(tree)
  .find((each) => typeof each.type === 'function' && each.props != null && prop in each.props);
const field = (tree, label) => elementsOf(tree).find((each) => each.props?.label === label);
const drawn = (tree, className) => findByClass(tree, className).map(textOf);
const refusals = (tree) => elementsOf(tree)
  .filter((each) => each.props?.error != null)
  .map((each) => [each.props.label, each.props.error]);
// The sheet writes the kept value straight onto the node when a clear is refused.
const typed = (value) => ({ target: { value, setSelectionRange: () => {} } });

// The sheet is reached the way a lifter reaches it: a new routine, a movement added, its row tapped.
async function openSheet(t) {
  browserWith();
  const { RoutineEditor } = await loadScreen('products/gym/Routines.jsx');
  const editor = renderHook(t, () => RoutineEditor({ id: NEW_ROUTINE_ID, log: LOG }));
  await settle();
  elementsOf(editor.tree).find((each) => textOf(each.props?.children) === '+ Add movement').props.onClick();
  handed(editor.tree, 'onPick').props.onPick('back-squat');
  handed(editor.tree, 'onTarget').props.onTarget(0);
  const sheet = handed(editor.tree, 'neverLogged');
  assert.equal(sheet.props.movement, 'Back Squat');
  return renderHook(t, () => sheet.type(sheet.props));
}

test('the sheet never blesses the line it is refusing: the open sentence waits for the refusal to go', async (t) => {
  const sheet = await openSheet(t);
  // An open row: the sentence is the whole of what the sheet says about the line.
  assert.deepEqual(drawn(sheet.tree, 'gym-open-line'), [OPEN_LINE]);
  assert.deepEqual(refusals(sheet.tree), []);

  // Reps typed onto a line with no sets. The sheet refuses that shape — and while it does, it does
  // not also tell the lifter the line is theirs to decide at the rack.
  field(sheet.tree, 'Reps').props.onChange(typed('5'));
  assert.deepEqual(refusals(sheet.tree), [['Sets', NAME_SETS_FIRST]]);
  assert.deepEqual(drawn(sheet.tree, 'gym-open-line'), []);
  assert.equal(field(sheet.tree, 'Reps').props.value, '5', 'nothing typed is dropped');

  // Clear it and the line is open again, refused by nothing: the sentence comes back.
  field(sheet.tree, 'Reps').props.onChange(typed(''));
  assert.deepEqual(refusals(sheet.tree), []);
  assert.deepEqual(drawn(sheet.tree, 'gym-open-line'), [OPEN_LINE]);

  // A named line is not the open one, so the sentence is not drawn whatever else is true of it.
  field(sheet.tree, 'Sets').props.onChange(typed('3'));
  assert.deepEqual(drawn(sheet.tree, 'gym-open-line'), []);
  field(sheet.tree, 'Reps').props.onChange(typed('400'));
  assert.deepEqual(refusals(sheet.tree), [['Reps', 'Whole reps, 1 to 100.']]);
  assert.deepEqual(drawn(sheet.tree, 'gym-open-line'), []);
});

test('the ± control is named `Flip the sign`, and the name sits on the control that flips it', async (t) => {
  const sheet = await openSheet(t);
  const sign = elementsOf(sheet.tree).find((each) => each.props?.className === 'gym-target-sign');
  assert.equal(sign.props['aria-label'], 'Flip the sign');
  assert.equal(textOf(sign), '±');
  assert.equal(sign.props.type, 'button');

  field(sheet.tree, 'Sets').props.onChange(typed('3'));
  field(sheet.tree, 'Reps').props.onChange(typed('8'));
  field(sheet.tree, 'Weight').props.onChange(typed('20'));
  sign.props.onClick();
  assert.equal(field(sheet.tree, 'Weight').props.value, '-20', 'band-assisted work, typed on the sheet');
  assert.deepEqual(refusals(sheet.tree), []);
  elementsOf(sheet.tree).find((each) => each.props?.className === 'gym-target-sign').props.onClick();
  assert.equal(field(sheet.tree, 'Weight').props.value, '20');
});

test('while a target sheet stands, the sheet owns the sentence and the list’s copy goes out', async (t) => {
  browserWith();
  const { RoutineEditor } = await loadScreen('products/gym/Routines.jsx');
  const editor = renderHook(t, () => RoutineEditor({ id: NEW_ROUTINE_ID, log: LOG }));
  await settle();
  elementsOf(editor.tree).find((each) => textOf(each.props?.children) === '+ Add movement').props.onClick();
  handed(editor.tree, 'onPick').props.onPick('back-squat');

  // One open row, no sheet: the list says once what the word `open` in the row means.
  assert.deepEqual(drawn(editor.tree, 'gym-open-line'), [OPEN_LINE]);

  // The row is tapped. The sheet is now the whole of what is said about that line — the list's copy
  // is not left lit behind the scrim beside whatever the sheet says in front of it.
  handed(editor.tree, 'onTarget').props.onTarget(0);
  assert.deepEqual(drawn(editor.tree, 'gym-open-line'), []);
  const sheet = handed(editor.tree, 'neverLogged');
  assert.deepEqual(drawn(renderHook(t, () => sheet.type(sheet.props)).tree, 'gym-open-line'), [OPEN_LINE]);

  // The sheet closes with nothing set: the row is still open, so the list takes the sentence back.
  sheet.props.onClose();
  assert.deepEqual(drawn(editor.tree, 'gym-open-line'), [OPEN_LINE]);

  // And a line the sheet named is not open any more, so nobody draws it.
  handed(editor.tree, 'onTarget').props.onTarget(0);
  handed(editor.tree, 'neverLogged').props.onSet({ exerciseId: 'back-squat', targetSets: 3, targetReps: 5 });
  assert.deepEqual(drawn(editor.tree, 'gym-open-line'), []);
});
