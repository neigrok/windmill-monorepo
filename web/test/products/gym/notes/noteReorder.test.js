import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_BASE } from '../../../../src/shell/apiBase.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, settle, textOf } from '../harness.mjs';

const STORED = [
  { id: 'note_a', position: 0, title: 'Bad shoulder', body: 'no overhead press' },
  { id: 'note_b', position: 1, title: 'Cutting', body: '' },
  { id: 'note_c', position: 2, title: 'Meet in June', body: '' },
];
const STYLES = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../src/products/gym/gym.css'),
  'utf8',
);

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

// The notes wire, ordered by the store: a whole-order replace answers the notes in the order it was
// sent, which is what the screen then holds.
function notesOnTheWire(wire) {
  global.fetch = async (url, options = {}) => {
    const route = url.slice(`${API_BASE}/v1/gym`.length);
    const method = options.method ?? 'GET';
    wire.push(`${method} ${route}`);
    if (route === '/notes' && method === 'GET') return { ok: true, status: 200, json: async () => ({ notes: STORED }) };
    if (route === '/notes' && method === 'PUT') {
      const { order } = JSON.parse(options.body);
      const notes = order.map((id, position) => ({ ...STORED.find((note) => note.id === id), position }));
      return { ok: true, status: 200, json: async () => ({ notes }) };
    }
    throw new Error(`unexpected ${method} ${route}`);
  };
}

// The list is reached the way a lifter reaches it — the Notes room, three notes on the wire — and the
// list itself is a child component, so it is rendered from the props the room hands it and
// re-rendered from the room's own next render, which is what a reorder causes.
async function openList(t) {
  browserWith();
  const wire = [];
  notesOnTheWire(wire);
  const { Notes } = await loadScreen('products/gym/notes/Notes.jsx');
  const room = renderHook(t, () => Notes({ log: roomLog() }));
  await settle();
  const held = () => elementsOf(room.tree)
    .find((each) => typeof each.type === 'function' && each.type.name === 'NoteList');
  // The room's `onMove` is counted on its way through, so a move the rail refuses can be told from
  // one it takes and then discards: a call that moves nothing still puts a whole order on the wire.
  let moves = 0;
  const view = renderHook(t, () => {
    const list = held();
    return list.type({ ...list.props, onMove: (from, to) => { moves += 1; return list.props.onMove(from, to); } });
  });
  return {
    order: () => held().props.notes.map((note) => note.id),
    rails: () => findByClass(view.tree, 'gym-note-rail'),
    said: () => findByClass(view.tree, 'gym-said')[0],
    moves: () => moves,
    wire: () => wire,
    press: (index, key) => {
      let prevented = false;
      findByClass(view.tree, 'gym-note-rail')[index].props.onKeyDown({ key, preventDefault: () => { prevented = true; } });
      view.redraw();
      return prevented;
    },
    // What a click, an Enter, a Space and a screen reader's double tap all become on a real button.
    // `detail` is how the two are told apart: a pointer's click counts the clicks, a keyboard's is 0.
    activate: async (index, detail = 1) => {
      findByClass(view.tree, 'gym-note-rail')[index].props.onClick({ detail });
      await settle();
      view.redraw();
    },
    // The pointer sequence, driven the way Chrome drives it: capture, one row of travel per row
    // crossed, then the release. `clicked` is whether the browser fires the trailing `click`, and
    // both endings are pinned because browsers differ: Chrome fires none after a drop that moved.
    pointer: async (index, rows, { clicked }) => {
      const rail = () => findByClass(view.tree, 'gym-note-rail')[index];
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
      await settle();
      view.redraw();
      if (clicked) {
        findByClass(view.tree, 'gym-note-rail')[index].props.onClick({ detail: 1 });
        await settle();
        view.redraw();
      }
    },
  };
}

test('the notes rail is a control, not only a drag: a button named for the note it moves', async (t) => {
  const list = await openList(t);
  assert.deepEqual(list.order(), ['note_a', 'note_b', 'note_c']);
  assert.deepEqual(list.rails().map((rail) => rail.type), ['button', 'button', 'button']);
  assert.deepEqual(list.rails().map((rail) => rail.props.type), ['button', 'button', 'button']);
  // It was `aria-hidden` and unreachable; the whole point is that it is neither now.
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-hidden']), [undefined, undefined, undefined]);
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-label']), [
    'Move Bad shoulder, 1 of 3',
    'Move Cutting, 2 of 3',
    'Move Meet in June, 3 of 3',
  ]);
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [false, false, false]);
  // The drag is not replaced by any of this.
  assert.deepEqual(
    ['onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel']
      .map((handler) => typeof list.rails()[0].props[handler]),
    ['function', 'function', 'function', 'function'],
  );
  // Said, not drawn: the row already carries its place in the handle's own name.
  assert.equal(list.said().props.role, 'status');
  assert.equal(textOf(list.said().props.children), '');
  assert.match(STYLES, /\.gym-said \{[^}]*clip: rect\(0 0 0 0\);/);
});

// SC 2.5.7 is not the keyboard criterion: it asks that what a drag reaches be reachable by a SINGLE
// POINTER without dragging. A phone browser has no arrow keys, and this list is reached only there
// as well as on the desktop.
test('a single pointer moves a note: one activation picks it up, the next on another handle places it', async (t) => {
  const list = await openList(t);

  await list.activate(0);
  assert.deepEqual(list.order(), ['note_a', 'note_b', 'note_c'], 'a pick-up moves nothing on its own');
  assert.equal(list.moves(), 0);
  assert.deepEqual(list.wire(), ['GET /notes'], 'and puts no order on the wire');
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [true, false, false]);
  assert.equal(list.rails()[0].props['aria-label'], 'Move Bad shoulder, 1 of 3 — picked up');
  assert.deepEqual(list.rails().slice(1).map((rail) => rail.props['aria-label']), [
    'Place Bad shoulder at 2 of 3',
    'Place Bad shoulder at 3 of 3',
  ]);
  assert.equal(textOf(list.said().props.children), 'Bad shoulder, 1 of 3 — picked up');

  await list.activate(2);
  assert.deepEqual(list.order(), ['note_b', 'note_c', 'note_a']);
  assert.equal(list.moves(), 1);
  // The whole order, every note once, in the order the list now holds.
  assert.deepEqual(list.wire(), ['GET /notes', 'PUT /notes']);
  assert.equal(textOf(list.said().props.children), 'Bad shoulder, 3 of 3');
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [false, false, false]);
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-label']), [
    'Move Cutting, 1 of 3',
    'Move Meet in June, 2 of 3',
    'Move Bad shoulder, 3 of 3',
  ]);
});

test('the same handle again puts the note down where it stands, and Escape puts it back', async (t) => {
  const list = await openList(t);

  await list.activate(1);
  await list.activate(1);
  assert.deepEqual(list.order(), ['note_a', 'note_b', 'note_c']);
  // Not merely unmoved: a `onMove` that ran would send a whole order for a cancelled pick-up.
  assert.equal(list.moves(), 0);
  assert.deepEqual(list.wire(), ['GET /notes']);
  assert.equal(textOf(list.said().props.children), 'Cutting, 2 of 3 — put back');
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [false, false, false]);

  await list.activate(1);
  assert.equal(list.press(1, 'Escape'), true, 'the key is taken, not left to the page');
  assert.deepEqual(list.order(), ['note_a', 'note_b', 'note_c']);
  assert.equal(list.moves(), 0);
  assert.deepEqual(list.wire(), ['GET /notes']);
  assert.equal(textOf(list.said().props.children), 'Cutting, 2 of 3 — put back');
  // Nothing is held now, so the next Escape is the page's again.
  assert.equal(list.press(1, 'Escape'), false);
});

test('the arrows move a note, the ends do not wrap, and every other key falls through', async (t) => {
  const list = await openList(t);

  assert.equal(list.press(0, 'ArrowDown'), true, 'the key is taken, not left to scroll the page');
  await settle();
  assert.deepEqual(list.order(), ['note_b', 'note_a', 'note_c']);
  assert.equal(textOf(list.said().props.children), 'Bad shoulder, 2 of 3');

  assert.equal(list.press(0, 'ArrowUp'), false, 'nothing is above the first row, so the page keeps its arrow');
  assert.equal(list.press(2, 'ArrowDown'), false);
  assert.deepEqual(list.order(), ['note_b', 'note_a', 'note_c']);
  assert.equal(list.moves(), 1, 'an end that called onMove anyway would send an order for nothing');

  // Enter and Space are the button's own click and are never read here; the rest are the page's.
  for (const key of ['Enter', ' ', 'Tab', 'ArrowLeft']) {
    assert.equal(list.press(0, key), false, key);
    assert.deepEqual(list.order(), ['note_b', 'note_a', 'note_c']);
  }
  assert.equal(list.moves(), 1);
});

test('the drag is untouched, and the click that ends it is not read as a pick-up', async (t) => {
  const list = await openList(t);
  await list.pointer(0, 1, { clicked: true });
  assert.deepEqual(list.order(), ['note_b', 'note_a', 'note_c']);
  assert.equal(list.moves(), 1, 'the drop moves the note once');
  assert.deepEqual(list.wire(), ['GET /notes', 'PUT /notes']);
  // The drop is a `click` as well as a pointer sequence; nothing is left held after it.
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [false, false, false]);
  assert.equal(textOf(list.said().props.children), 'Bad shoulder, 2 of 3');

  // And the click it spent is the drop's own: the next tap is a pick-up, not a second helping.
  await list.pointer(1, 0, { clicked: true });
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [false, true, false]);
  assert.equal(textOf(list.said().props.children), 'Bad shoulder, 2 of 3 — picked up');
  assert.equal(list.moves(), 1);
});

// The ending Chrome actually produces: no trailing click at all. A guard waiting for one swallows
// the next real tap instead, and the pick-up then needs two.
test('a drop whose click never comes does not swallow the next tap', async (t) => {
  const list = await openList(t);
  await list.pointer(0, 1, { clicked: false });
  assert.deepEqual(list.order(), ['note_b', 'note_a', 'note_c']);
  assert.equal(list.moves(), 1);

  await list.pointer(0, 0, { clicked: true });
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [true, false, false]);
  assert.equal(textOf(list.said().props.children), 'Cutting, 1 of 3 — picked up');
  assert.equal(list.moves(), 1, 'a tap that lands where it started moves nothing');
  assert.deepEqual(list.wire(), ['GET /notes', 'PUT /notes']);
});

// A keyboard's click carries no pointer (`detail === 0`), so it is never a drop's own click.
test('a keyboard activation after a drop is not spent on the drop', async (t) => {
  const list = await openList(t);
  await list.pointer(0, 1, { clicked: false });
  await list.activate(0, 0);
  assert.deepEqual(list.rails().map((rail) => rail.props['aria-pressed']), [true, false, false]);
  assert.equal(textOf(list.said().props.children), 'Cutting, 1 of 3 — picked up');
});
