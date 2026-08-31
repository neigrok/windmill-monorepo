import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NEW_ROUTINE_ID } from '../../../src/products/gym/log.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, settle, textOf } from './harness.mjs';

const CATALOG = [
  { id: 'back-squat', name: 'Back Squat' },
  { id: 'rdl', name: 'Romanian Deadlift' },
  { id: 'leg-press', name: 'Leg Press' },
];
const LOG = roomLog({ catalog: CATALOG });
const STYLES = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/products/gym/gym.css'),
  'utf8',
);

const handed = (tree, prop) => elementsOf(tree)
  .find((each) => typeof each.type === 'function' && each.props != null && prop in each.props);

// The list is reached the way a lifter reaches it: a new routine, three movements added through the
// picker. The list itself is a child component, so it is rendered from the props the editor hands it
// and re-rendered from the editor's own next render — which is what a reorder causes.
async function openList(t) {
  browserWith();
  const { RoutineEditor } = await loadScreen('products/gym/Routines.jsx');
  const editor = renderHook(t, () => RoutineEditor({ id: NEW_ROUTINE_ID, log: LOG }));
  await settle();
  for (const movement of CATALOG) {
    elementsOf(editor.tree).find((each) => textOf(each.props?.children) === '+ Add movement').props.onClick();
    handed(editor.tree, 'onPick').props.onPick(movement.id);
  }
  const list = () => elementsOf(editor.tree)
    .find((each) => typeof each.type === 'function' && each.type.name === 'EntryList');
  // The editor's `onMove` is counted on its way through, so a keystroke the list refuses can be told
  // from one it takes and then discards: a call that moves nothing still turns a clean draft dirty.
  let moves = 0;
  const view = renderHook(t, () => {
    const held = list();
    return held.type({ ...held.props, onMove: (from, to) => { moves += 1; held.props.onMove(from, to); } });
  });
  return {
    order: () => list().props.entries.map((entry) => entry.exerciseId),
    rails: () => findByClass(view.tree, 'gym-entry-rail'),
    moves: () => moves,
    said: () => findByClass(view.tree, 'gym-said')[0],
    // The editor's own re-render is what the room does; the list redraws from the props it produced.
    press: (index, key) => {
      let prevented = false;
      findByClass(view.tree, 'gym-entry-rail')[index].props.onKeyDown({ key, preventDefault: () => { prevented = true; } });
      view.redraw();
      return prevented;
    },
    // What a click, an Enter, a Space and a screen reader's double tap all become on a real button.
    // `detail` is how the two are told apart: a pointer's click counts the clicks, a keyboard's is 0.
    activate: (index, detail = 1) => {
      findByClass(view.tree, 'gym-entry-rail')[index].props.onClick({ detail });
      view.redraw();
    },
    // The pointer sequence, driven the way Chrome drives it: capture, one row of travel per row
    // crossed, then the release. `clicked` is whether the browser fires the trailing `click`, and
    // both endings are pinned because browsers differ: Chrome fires none after a drop that moved
    // (the row travels out from under the release), and a browser that fires one must not read it
    // as a pick-up.
    pointer: (index, rows, { clicked }) => {
      const rail = () => findByClass(view.tree, 'gym-entry-rail')[index];
      const height = 60;
      rail().props.onPointerDown({
        pointerId: 1,
        clientY: 0,
        currentTarget: {
          setPointerCapture: () => {},
          closest: () => ({ getBoundingClientRect: () => ({ height }) }),
        },
      });
      view.redraw();
      if (rows !== 0) {
        rail().props.onPointerMove({ clientY: rows * height });
        view.redraw();
      }
      rail().props.onPointerUp({ clientY: rows * height });
      view.redraw();
      if (clicked) {
        findByClass(view.tree, 'gym-entry-rail')[index].props.onClick({ detail: 1 });
        view.redraw();
      }
    },
  };
}

test('the draft reorder is a control, not only a drag: the handle is a button named for the row it moves', async (t) => {
  const list = await openList(t);
  assert.deepEqual(list.order(), ['back-squat', 'rdl', 'leg-press']);
  assert.deepEqual(list.rails().map((rail) => rail.type), ['button', 'button', 'button']);
  assert.deepEqual(list.rails().map((rail) => rail.props.type), ['button', 'button', 'button']);
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-hidden']), [undefined, undefined, undefined]);
  // Which row, and where it stands: `3 × 5 · 60 kg` would name neither.
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-label']), [
    'Move Back Squat, 1 of 3',
    'Move Romanian Deadlift, 2 of 3',
    'Move Leg Press, 3 of 3',
  ]);
  // The drag is not replaced by any of this.
  assert.deepEqual(
    ['onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel']
      .map((handler) => typeof list.rails()[0].props[handler]),
    ['function', 'function', 'function', 'function'],
  );
});

test('the arrows move the row, and the move is said as well as done', async (t) => {
  const list = await openList(t);
  // Nothing has moved, so the line that says where a row landed says nothing.
  assert.equal(list.said().props.role, 'status');
  assert.equal(textOf(list.said().props.children), '');
  // Said, not drawn: the row already carries its place in the handle's own name, and a second copy
  // of it under the list would be the same fact twice.
  assert.match(STYLES, /\.gym-said \{[^}]*clip: rect\(0 0 0 0\);/);

  assert.equal(list.press(0, 'ArrowDown'), true, 'the key is taken, not left to scroll the page');
  assert.deepEqual(list.order(), ['rdl', 'back-squat', 'leg-press']);
  assert.equal(list.rails()[1].props['aria-label'], 'Move Back Squat, 2 of 3');
  assert.equal(list.rails()[0].props['aria-label'], 'Move Romanian Deadlift, 1 of 3');
  // A name changing under a focus that jumped is not an announcement: the row's new place is said
  // on a channel of its own, and the same line carries the drag, which says nothing on its own.
  assert.equal(textOf(list.said().props.children), 'Back Squat, 2 of 3');

  assert.equal(list.press(1, 'ArrowUp'), true);
  assert.deepEqual(list.order(), ['back-squat', 'rdl', 'leg-press']);
  assert.equal(list.rails()[0].props['aria-label'], 'Move Back Squat, 1 of 3');
  assert.equal(textOf(list.said().props.children), 'Back Squat, 1 of 3');
});

test('the ends do not wrap, and an arrow the handle cannot spend falls through with every other key', async (t) => {
  const list = await openList(t);

  assert.equal(list.press(0, 'ArrowUp'), false, 'nothing is above the first row, so the page keeps its arrow');
  assert.deepEqual(list.order(), ['back-squat', 'rdl', 'leg-press']);
  assert.equal(list.press(2, 'ArrowDown'), false);
  assert.deepEqual(list.order(), ['back-squat', 'rdl', 'leg-press']);
  // Unmoved is not enough: the order is clamped downstream, so an end that called `onMove` anyway
  // would leave the list looking untouched while the draft counted as edited and nothing was said.
  assert.equal(list.moves(), 0);
  assert.equal(textOf(list.said().props.children), '');

  // Enter, Space and Escape are in this list for three different reasons: the first two are the
  // button's own click and are never read here, and Escape is spent only while a row is held.
  for (const key of ['Enter', ' ', 'Escape', 'Tab', 'ArrowLeft']) {
    assert.equal(list.press(0, key), false, key);
    assert.deepEqual(list.order(), ['back-squat', 'rdl', 'leg-press']);
  }
  assert.equal(list.moves(), 0);
});

// SC 2.5.7 is not the keyboard criterion: it asks that what a drag reaches be reachable by a SINGLE
// POINTER without dragging. On a phone browser there are no arrow keys, so these are the cases that
// decide whether a lifter on VoiceOver or TalkBack can move a movement at all.
test('a single pointer moves a row: one activation picks it up, the next on another handle places it', async (t) => {
  const list = await openList(t);
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [false, false, false]);

  list.activate(0);
  assert.deepEqual(list.order(), ['back-squat', 'rdl', 'leg-press'], 'a pick-up moves nothing on its own');
  assert.equal(list.moves(), 0);
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [true, false, false]);
  assert.equal(list.rails()[0].props['aria-label'], 'Move Back Squat, 1 of 3 — picked up');
  // The other handles stop being moves and become places: the row they would take is named.
  assert.deepEqual(list.rails().slice(1).map((rail) => rail.props['aria-label']), [
    'Place Back Squat at 2 of 3',
    'Place Back Squat at 3 of 3',
  ]);
  assert.equal(textOf(list.said().props.children), 'Back Squat, 1 of 3 — picked up');

  list.activate(2);
  assert.deepEqual(list.order(), ['rdl', 'leg-press', 'back-squat']);
  assert.equal(list.moves(), 1);
  // Placed, and said as a landing rather than as a pick-up: the same line the arrows and the drag use.
  assert.equal(textOf(list.said().props.children), 'Back Squat, 3 of 3');
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [false, false, false]);
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-label']), [
    'Move Romanian Deadlift, 1 of 3',
    'Move Leg Press, 2 of 3',
    'Move Back Squat, 3 of 3',
  ]);
});

test('the pick-up costs nothing to discover: the same handle again puts the row down where it stands', async (t) => {
  const list = await openList(t);
  list.activate(1);
  assert.equal(list.rails()[1].props['aria-label'], 'Move Romanian Deadlift, 2 of 3 — picked up');

  list.activate(1);
  assert.deepEqual(list.order(), ['back-squat', 'rdl', 'leg-press']);
  // Not merely unmoved: a `onMove` that ran would turn a clean draft dirty for a cancelled pick-up.
  assert.equal(list.moves(), 0);
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [false, false, false]);
  assert.equal(list.rails()[1].props['aria-label'], 'Move Romanian Deadlift, 2 of 3');
  assert.equal(textOf(list.said().props.children), 'Romanian Deadlift, 2 of 3 — put back');
});

test('Escape puts a held row back, and is spent only while one is held', async (t) => {
  const list = await openList(t);
  list.activate(0);
  assert.equal(list.press(0, 'Escape'), true, 'the key is taken, not left to the page');
  assert.deepEqual(list.order(), ['back-squat', 'rdl', 'leg-press']);
  assert.equal(list.moves(), 0);
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [false, false, false]);
  assert.equal(textOf(list.said().props.children), 'Back Squat, 1 of 3 — put back');
  // Nothing is held now, so the next Escape is the page's again.
  assert.equal(list.press(0, 'Escape'), false);
});

test('the arrows move the row a pointer is holding, and it stays held as it travels', async (t) => {
  const list = await openList(t);
  list.activate(0);

  // The arrow is pressed on the handle the focus happens to be on; the held row is what moves.
  assert.equal(list.press(2, 'ArrowDown'), true);
  assert.deepEqual(list.order(), ['rdl', 'back-squat', 'leg-press']);
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [false, true, false]);
  assert.equal(list.rails()[1].props['aria-label'], 'Move Back Squat, 2 of 3 — picked up');
  assert.equal(textOf(list.said().props.children), 'Back Squat, 2 of 3');
});

test('the drag is untouched, and a trailing click is not read as a pick-up', async (t) => {
  const list = await openList(t);
  list.pointer(0, 1, { clicked: true });
  assert.deepEqual(list.order(), ['rdl', 'back-squat', 'leg-press']);
  assert.equal(list.moves(), 1, 'the drop moves the row once');
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [false, false, false]);
  assert.equal(textOf(list.said().props.children), 'Back Squat, 2 of 3');
});

// This is the ending Chrome actually produces, and the one that bit: a guard waiting for a click
// that never comes swallows the next real tap instead, and the pick-up then needs two.
test('a drop whose click never comes does not swallow the next tap', async (t) => {
  const list = await openList(t);
  list.pointer(0, 1, { clicked: false });
  assert.deepEqual(list.order(), ['rdl', 'back-squat', 'leg-press']);
  assert.equal(list.moves(), 1);

  list.pointer(0, 0, { clicked: true });
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [true, false, false]);
  assert.equal(textOf(list.said().props.children), 'Romanian Deadlift, 1 of 3 — picked up');
  assert.equal(list.moves(), 1, 'a tap that lands where it started moves nothing');
});

// The same drop, and then a keyboard: a keyboard's click carries no pointer (`detail === 0`), so it
// is never the drop's own click and is never spent as one.
test('a keyboard activation after a drop is not spent on the drop', async (t) => {
  const list = await openList(t);
  list.pointer(0, 1, { clicked: false });
  list.activate(0, 0);
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [true, false, false]);
  assert.equal(textOf(list.said().props.children), 'Romanian Deadlift, 1 of 3 — picked up');
});
