import test from 'node:test';
import assert from 'node:assert/strict';
import { RPE_RUNGS, SET_NOTE_CAPTION } from '../../../src/products/gym/fix.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, textOf } from './harness.mjs';

async function sheet(t, changes = {}, refused = null) {
  browserWith();
  const { FixSheet } = await loadScreen('products/gym/FixSheet.jsx');
  const saved = [];
  const view = renderHook(t, () => FixSheet({
    set: { id: 'set_3', exerciseId: 'overhead-press', setNumber: 3, weightKg: 47.5, reps: 4, kind: 'working', rpe: 8.5, note: 'felt heavy', ...changes },
    movement: 'Overhead Press', session: { id: 'ses_1', plan: null },
    onSave: (fix) => { saved.push(fix); return refused; }, onDelete() {}, onClose() {},
  }));
  const noteField = () => elementsOf(view.tree).find((each) => each.type === 'textarea' && each.props?.name === 'note');
  const field = (name) => elementsOf(view.tree).find((each) => each.props?.name === name);
  const ratings = () => elementsOf(findByClass(view.tree, 'gym-fix-ratings')[0]).filter((each) => each.type === 'button');
  const rate = (label) => ratings().find((each) => textOf(each) === label).props.onClick();
  return { saved, tree: () => view.tree, noteField, field, ratings, rate,
    type: (text) => noteField().props.onChange({ target: { value: text } }),
    submit: () => elementsOf(view.tree).find((each) => each.type === 'form').props.onSubmit({ preventDefault() {} }),
  };
}

test('rating options retain Not rated and six through ten by halves, with an explicit null clearing', async (t) => {
  const fix = await sheet(t);
  assert.deepEqual(fix.ratings().map(textOf), ['Not rated', ...RPE_RUNGS.map(String)]);
  assert.deepEqual(fix.ratings().filter((each) => each.props['aria-pressed']).map(textOf), ['8.5']);
  fix.rate('9.5');
  await fix.submit();
  fix.rate('Not rated');
  await fix.submit();
  assert.deepEqual(fix.saved, [{ rpe: 9.5 }, { rpe: null }]);
});

test('set notes keep their disclosure and clear explicitly, while untouched notes are omitted', async (t) => {
  const fix = await sheet(t);
  assert.equal(fix.noteField().props['aria-describedby'], 'gym-set-note-caption');
  assert.equal(textOf(findByClass(fix.tree(), 'gym-fix-note-caption')[0]), SET_NOTE_CAPTION);
  fix.type('');
  await fix.submit();
  assert.deepEqual(fix.saved, [{ note: '' }]);
  const never = await sheet(t, { note: undefined, rpe: undefined });
  await never.submit();
  assert.deepEqual(never.saved, [{}]);
});

test('byte limits preserve typed notes and explain refusal without sending an invalid correction', async (t) => {
  const fix = await sheet(t);
  fix.type('a'.repeat(3199));
  assert.deepEqual(findByClass(fix.tree(), 'gym-name-count'), []);
  fix.type('a'.repeat(3200));
  assert.deepEqual(findByClass(fix.tree(), 'gym-name-count').map(textOf), ['3200 of 4000 bytes']);
  fix.type('—'.repeat(1334));
  assert.equal(fix.noteField().props['aria-invalid'], true);
  assert.deepEqual(findByClass(fix.tree(), 'gym-fix-refusal').map(textOf), ['A set note runs to 4000 bytes.']);
  assert.equal(findByClass(fix.tree(), 'gym-name-count')[0].props.className, 'gym-name-count is-over');
  assert.deepEqual(findByClass(fix.tree(), 'gym-name-count').map(textOf), ['4002 of 4000 bytes']);
  await fix.submit();
  assert.deepEqual(fix.saved, []);
  assert.equal(fix.noteField().props.value, '—'.repeat(1334));
  fix.type('felt heavy');
  assert.deepEqual(findByClass(fix.tree(), 'gym-name-count'), []);
});

test('web corrections edit actual numbers in place and retain stored kind through a refused retry', async (t) => {
  const fix = await sheet(t, { kind: 'warmup' }, 'The log didn’t answer.');
  assert.deepEqual(elementsOf(fix.tree()).filter((each) => each.type === 'input').map((each) => each.props['aria-label']), ['Load in kg', 'Reps']);
  fix.field('reps').props.onChange({ target: { value: '5' } });
  await fix.submit();
  assert.deepEqual(fix.saved, [{ reps: 5 }]);
  assert.equal(fix.field('reps').props.value, '5');
  assert.deepEqual(findByClass(fix.tree(), 'gym-fix-refusal').map(textOf), ['The log didn’t answer.']);
  assert.equal(elementsOf(fix.tree()).some((each) => typeof each.type === 'function' && each.type.name === 'Keypad'), false);
});


test('fixing one value preserves an existing rating outside the capture scale and high reps', async (t) => {
  const fix = await sheet(t, { reps: 101, rpe: 5.3 });
  assert.deepEqual(fix.ratings().map(textOf), ['Not rated', '5.3', ...RPE_RUNGS.map(String)]);
  fix.field('weightKg').props.onChange({ target: { value: '50' } });
  await fix.submit();
  assert.deepEqual(fix.saved, [{ weightKg: 50 }]);
  assert.equal(fix.field('reps').props.value, '101');
  assert.deepEqual(fix.ratings().filter((each) => each.props['aria-pressed']).map(textOf), ['5.3']);
});


test('focused correction retains surrounding saved rows and refuses overflow under the selected row', async (t) => {
  browserWith();
  const { FixSheet } = await loadScreen('products/gym/FixSheet.jsx');
  const sets = [1, 2, 3].map((setNumber) => ({ id: `set_${setNumber}`, exerciseId: 'bench', setNumber, weightKg: 60, reps: 8, kind: 'working' }));
  const saved = [];
  const view = renderHook(t, () => FixSheet({ set: sets[1], sets, movement: 'Bench Press', session: { startedAt: new Date(2026, 8, 7).getTime() }, onSave: (fix) => saved.push(fix), onDelete() {}, onClose() {} }));
  assert.deepEqual(findByClass(view.tree, 'gym-fix-sibling').map(textOf), ['60 × 8', '60 × 8']);
  assert.equal(textOf(findByClass(view.tree, 'gym-fix-movement')[0]), 'Bench Press3 × 8 · 60');
  elementsOf(view.tree).find((each) => each.props?.name === 'weightKg').props.onChange({ target: { value: '625' } });
  await elementsOf(view.tree).find((each) => each.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(saved, []);
  assert.deepEqual(findByClass(view.tree, 'gym-fix-refusal').map(textOf), ['Over 500 kg — check the number.']);
  assert.equal(elementsOf(view.tree).find((each) => each.props?.name === 'weightKg').props.value, '625');
  assert.equal(textOf(findByClass(view.tree, 'gym-fix-movement')[0]), 'Bench Press3 × 8 · 60');
});

test('focused correction disables fields and navigation while its write is pending', async (t) => {
  browserWith();
  const { FixSheet } = await loadScreen('products/gym/FixSheet.jsx');
  let finish;
  const view = renderHook(t, () => FixSheet({ set: { id: 'set_1', exerciseId: 'bench', weightKg: 60, reps: 8 }, movement: 'Bench Press', session: {}, onSave: () => new Promise((resolve) => { finish = resolve; }), onDelete() {}, onClose() {} }));
  const pending = elementsOf(view.tree).find((each) => each.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(elementsOf(view.tree).find((each) => each.type === 'fieldset').props.disabled, true);
  assert.equal(findByClass(view.tree, 'gym-fix-cancel')[0].props.disabled, true);
  assert.equal(elementsOf(view.tree).find((each) => each.props?.type === 'submit').props.ariaBusy, true);
  finish('The log didn’t answer.');
  await pending;
  assert.equal(elementsOf(view.tree).find((each) => each.type === 'fieldset').props.disabled, false);
  assert.deepEqual(findByClass(view.tree, 'gym-fix-refusal').map(textOf), ['The log didn’t answer.']);
});
