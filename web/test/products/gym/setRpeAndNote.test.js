import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_RPE_LABEL, RPE_RUNGS, SET_NOTE_BYTES, SET_NOTE_CAPTION,
} from '../../../src/products/gym/fix.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, textOf } from './harness.mjs';

const SET = {
  id: 'set_3', exerciseId: 'overhead-press', setNumber: 3, weightKg: 47.5, reps: 4,
  kind: 'working', rpe: 8.5, note: 'felt heavy', completedAt: 1_900_000_300_000,
};
const SESSION = { id: 'ses_1', startedAt: 1_900_000_000_000, finishedAt: 1_900_003_600_000, plan: null };

async function sheet(t, set = SET) {
  browserWith();
  const { FixSheet } = await loadScreen('products/gym/FixSheet.jsx');
  const saved = [];
  const view = renderHook(t, () => FixSheet({
    set,
    movement: 'Overhead Press',
    session: SESSION,
    onSave: (fix) => saved.push(fix),
    onDelete: () => {},
    onClose: () => {},
  }));
  const noteField = () => elementsOf(view.tree).find((each) => each.props?.label === 'Set note');
  return {
    saved,
    tree: () => view.tree,
    seats: () => findByClass(view.tree, 'gym-rpe'),
    noteField,
    type: (text) => noteField().props.onChange({ target: { value: text } }),
    save: () => findByClass(view.tree, 'gym-fix-save')[0],
  };
}

test('the rpe control is ten seats — Not rated, then six to ten by halves — and the set’s own is pressed', async (t) => {
  const fix = await sheet(t);
  assert.deepEqual(fix.seats().map(textOf), ['Not rated', ...RPE_RUNGS.map(String)]);
  assert.deepEqual(fix.seats().map((seat) => seat.props['aria-pressed']), [
    false, false, false, false, false, false, true, false, false, false,
  ]);
  // The seat is named by the words it draws, like the nine beside it: no aria-label stands between a
  // screen reader and the face of the control. The dash it used to wear was announced as nothing.
  assert.equal(textOf(fix.seats()[0]), NO_RPE_LABEL);
  assert.deepEqual(fix.seats().map((seat) => seat.props['aria-label']), new Array(10).fill(undefined));
});

test('choosing an rpe sends that field alone; taking the rating off names it null', async (t) => {
  const fix = await sheet(t);
  fix.seats()[8].props.onClick();
  assert.equal(fix.seats()[8].props['aria-pressed'], true);
  fix.save().props.onClick();
  assert.deepEqual(fix.saved, [{ rpe: 9.5 }]);

  fix.seats()[0].props.onClick();
  fix.save().props.onClick();
  assert.deepEqual(fix.saved[1], { rpe: null });
  assert.equal(JSON.stringify(fix.saved[1]), '{"rpe":null}');
});

test('the set note is a record, and the line saying so is the field’s own description', async (t) => {
  const fix = await sheet(t);
  assert.equal(fix.noteField().props.value, 'felt heavy');
  assert.equal(fix.noteField().props.describedBy, 'gym-set-note-caption');
  const caption = findByClass(fix.tree(), 'gym-fix-note-caption')[0];
  assert.equal(caption.props.id, 'gym-set-note-caption');
  assert.equal(textOf(caption), SET_NOTE_CAPTION);
  assert.equal(textOf(caption), 'A record for you — not an instruction to Coach.');
});

test('emptying the note clears it on the wire; a note nobody touched is not on the wire at all', async (t) => {
  const fix = await sheet(t);
  fix.type('');
  fix.save().props.onClick();
  assert.deepEqual(fix.saved, [{ note: '' }]);
  assert.equal(JSON.stringify(fix.saved[0]), '{"note":""}');

  const never = await sheet(t, { ...SET, rpe: undefined, note: undefined });
  never.save().props.onClick();
  assert.deepEqual(never.saved, [{}], 'an empty field that was already empty says nothing');
  never.type('felt easy');
  never.save().props.onClick();
  assert.deepEqual(never.saved[1], { note: 'felt easy' });
});

test('a note past the store’s bound is refused here, because the store’s own reply cannot say why', async (t) => {
  const fix = await sheet(t);
  fix.type('a'.repeat(SET_NOTE_BYTES + 1));
  assert.equal(fix.noteField().props.error, 'A set note runs to 4000 bytes.');
  assert.equal(fix.save().props.className, 'gym-fix-save is-inert');
  fix.save().props.onClick();
  assert.deepEqual(fix.saved, [], 'nothing unstorable ever leaves this sheet');

  // Bytes, not characters: three-byte glyphs reach the bound at a third of the count.
  fix.type('—'.repeat(SET_NOTE_BYTES / 3));
  assert.equal(fix.noteField().props.error, undefined);
  fix.type('—'.repeat(SET_NOTE_BYTES / 3 + 1));
  assert.notEqual(fix.noteField().props.error, undefined);

  // The counter is chrome a short note does not need, and appears in the last fifth.
  fix.type('a'.repeat(3199));
  assert.equal(fix.noteField().props.trailing, false);
  fix.type('a'.repeat(3200));
  assert.equal(textOf(fix.noteField().props.trailing), '3200 of 4000 bytes');
});

test('a byte counter past its bound goes alarm, in the class the room’s other counters already wear', async (t) => {
  const fix = await sheet(t);
  const counter = () => fix.noteField().props.trailing;

  // Inside the bound the counter is quiet — at the very last byte it holds, because the store does.
  fix.type('a'.repeat(3200));
  assert.equal(counter().props.className, 'gym-name-count');
  fix.type('a'.repeat(SET_NOTE_BYTES));
  assert.equal(counter().props.className, 'gym-name-count');
  assert.equal(textOf(counter()), '4000 of 4000 bytes');
  assert.equal(fix.noteField().props.error, undefined);

  // One byte past it, the counter and the refusal turn together: the ink is never quiet under a
  // sentence that is still refusing, and `is-over` is the note editor's own state, not a second one.
  fix.type('a'.repeat(SET_NOTE_BYTES + 1));
  assert.equal(counter().props.className, 'gym-name-count is-over');
  assert.equal(textOf(counter()), '4001 of 4000 bytes');
  assert.equal(fix.noteField().props.error, 'A set note runs to 4000 bytes.');

  // Bytes and not characters here too: 1334 em dashes are 4002 bytes.
  fix.type('—'.repeat(SET_NOTE_BYTES / 3));
  assert.equal(counter().props.className, 'gym-name-count');
  fix.type('—'.repeat(SET_NOTE_BYTES / 3 + 1));
  assert.equal(counter().props.className, 'gym-name-count is-over');
  assert.equal(textOf(counter()), '4002 of 4000 bytes');

  // And it comes back: an over-long note cut back under the bound leaves no alarm behind.
  fix.type('felt heavy');
  assert.equal(counter(), false);
});
