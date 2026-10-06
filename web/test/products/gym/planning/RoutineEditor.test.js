import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTINES_HREF } from '../../../../src/products/gym/log.js';
import { createGymApi } from '../../../../src/products/gym/gymSync.js';
import { browserWith, confirmed, elementsOf, findByClass, gymAccount, loadScreen, renderHook, roomLog, settle, textOf } from '../harness.mjs';

function button(tree, label) {
  return elementsOf(tree).find((element) => element.props?.children === label && element.type?.name === 'Button');
}

// The same routine as another device saved it: the server's newer stamp on every field it changed.
const savedElsewhere = (row, fields, seq) => ({ ...row, seq,
  f: { ...row.f, ...Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, [value, '2:0:srv']])) } });
const differences = (tree) => findByClass(tree, 'gym-plan-differences')
  .flatMap((section) => elementsOf(section).filter((element) => element.type === 'div').map((row) => textOf(row)));

test('a stale save compares both versions and Keep both preserves the saved routine', async (t) => {
  browserWith();
  const pushA = confirmed('routine', 'routinePushA', { name: 'Push A', position: 0, entries: [{ exerciseId: 'bench-press', sets: [{ weightKg: 60, reps: 8 }] }] });
  const gym = await gymAccount(t, [pushA]);
  const { RoutineEditor } = await loadScreen('products/gym/Routines.jsx');
  const screen = renderHook(t, () => RoutineEditor({ id: 'routinePushA', log: roomLog({ catalog: [{ id: 'bench-press', name: 'Bench Press' }] }) }));
  await settle();
  findByClass(screen.tree, 'gym-plan-name')[0].props.onChange({ target: { value: 'My retained draft' } });
  const target = elementsOf(screen.tree).find((element) => element.type?.name === 'TargetEditor');
  target.props.onDraft({ exerciseId: 'bench-press', sets: [{ weightKg: 62.5, reps: 8 }] });
  await gym.land(savedElsewhere(pushA, { name: 'Saved elsewhere' }, 2));

  await button(screen.tree, 'Save routine').props.onClick();
  await settle();
  assert.deepEqual(gym.owed(), [], 'the save over a routine that moved is refused whole');
  assert.equal(findByClass(screen.tree, 'gym-plan-versions').length, 1);
  assert.equal(button(screen.tree, 'Save routine'), undefined);
  assert.equal(findByClass(screen.tree, 'gym-plan-version-columns').length, 1);
  assert.deepEqual(differences(screen.tree), [
    'NamePush A → My retained draftYours',
    'Bench Press60 → 62.5Yours',
    'NamePush A → Saved elsewhereSaved',
  ], 'the draft kept every edit, and the saved routine is read beside it');

  await button(screen.tree, 'Keep both').props.onClick();
  await settle();
  const routines = (await createGymApi(gym.engine).routines()).map(({ id, name, position, entries }) => ({ id, name, position, entries }));
  const copy = routines.find((routine) => routine.id !== 'routinePushA');
  assert.deepEqual(gym.owed(), [`ready create routine ${copy.id} entries name position`]);
  assert.deepEqual(routines, [
    { id: 'routinePushA', name: 'Saved elsewhere', position: 0, entries: [{ position: 1, exerciseId: 'bench-press', sets: [{ reps: 8, weightKg: 60 }] }] },
    { id: copy.id, name: 'My retained draft', position: 0, entries: [{ position: 1, exerciseId: 'bench-press', sets: [{ reps: 8, weightKg: 62.5 }] }] },
  ]);
  assert.equal(window.location.hash, ROUTINES_HREF);
});

test('a sync update leaves the draft and its original save guard together', async (t) => {
  browserWith();
  const read = confirmed('routine', 'routinePushA', { name: 'Read version', position: 0, entries: [{ exerciseId: 'bench-press' }] });
  const gym = await gymAccount(t, [read]);
  const { RoutineEditor } = await loadScreen('products/gym/Routines.jsx');
  const screen = renderHook(t, () => RoutineEditor({ id: 'routinePushA', log: roomLog() }), { live: true });
  await settle();
  findByClass(screen.tree, 'gym-plan-name')[0].props.onChange({ target: { value: 'Retained draft' } });

  // The phone saves the routine while the draft is open, and the store moves under the editor.
  await gym.land(savedElsewhere(read, { name: 'Phone edit' }, 2));
  await settle();
  assert.equal(findByClass(screen.tree, 'gym-plan-name')[0].props.value, 'Retained draft');

  // The save carries the registers the draft was read from, so it meets the phone's edit instead of
  // writing over it.
  await button(screen.tree, 'Save routine').props.onClick();
  await settle();
  assert.deepEqual(gym.owed(), [], 'nothing is written over the phone’s edit');
  assert.equal(textOf(findByClass(screen.tree, 'gym-plan-kicker')[0]), 'Read version', 'the versions are compared against the read the draft began from');
  assert.deepEqual(differences(screen.tree), [
    'NameRead version → Retained draftYours',
    'NameRead version → Phone editSaved',
  ]);
});

test('a save over a routine nobody else moved writes only the draft’s changes, under the read’s guard', async (t) => {
  browserWith();
  const gym = await gymAccount(t, [confirmed('routine', 'routinePushA', { name: 'Read version', position: 0, entries: [{ exerciseId: 'bench-press' }] })]);
  const { RoutineEditor } = await loadScreen('products/gym/Routines.jsx');
  const screen = renderHook(t, () => RoutineEditor({ id: 'routinePushA', log: roomLog() }), { live: true });
  await settle();
  findByClass(screen.tree, 'gym-plan-name')[0].props.onChange({ target: { value: 'Retained draft' } });

  await button(screen.tree, 'Save routine').props.onClick();
  await settle();
  assert.deepEqual(gym.owed(), ['ready update routine routinePushA name']);
  assert.deepEqual(gym.engine.device.activeReplica.entries()[0].intent.guard.map(({ t: type, id, field }) => `${type} ${id} ${field}`),
    ['routine routinePushA name', 'routine routinePushA entries', 'routine routinePushA position']);
  assert.equal(window.location.hash, ROUTINES_HREF);
});
