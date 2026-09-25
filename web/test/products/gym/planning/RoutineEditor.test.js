import test from 'node:test';
import assert from 'node:assert/strict';
import { gymApi } from '../../../../src/products/gym/gymApi.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, settle } from '../harness.mjs';

function button(tree, label) {
  return elementsOf(tree).find((element) => element.props?.children === label && element.type?.name === 'Button');
}

test('a stale save compares both versions and Keep both preserves the saved routine', async (t) => {
  browserWith();
  const routine = { id: 'routine', name: 'Push A', position: 0, revision: 1, entries: [{ exerciseId: 'bench', sets: [{ weightKg: 60, reps: 8 }] }] };
  let reads = 0;
  t.mock.method(gymApi, 'routine', async () => ++reads === 1 ? routine : { ...routine, name: 'Saved elsewhere', revision: 2 });
  const writes = [];
  t.mock.method(gymApi, 'replaceRoutine', async (id, write) => {
    writes.push({ id, write });
    if (writes.length === 1) throw { code: 'routine-stale' };
  });
  const copies = [];
  t.mock.method(gymApi, 'createRoutine', async (write) => copies.push(write));
  const { RoutineEditor } = await loadScreen('products/gym/Routines.jsx');
  const screen = renderHook(t, () => RoutineEditor({ id: 'routine', log: roomLog({ catalog: [{ id: 'bench', name: 'Bench Press' }] }) }));
  await settle();
  findByClass(screen.tree, 'gym-plan-name')[0].props.onChange({ target: { value: 'My retained draft' } });
  const target = elementsOf(screen.tree).find((element) => element.type?.name === 'TargetEditor');
  target.props.onDraft({ exerciseId: 'bench', sets: [{ weightKg: 62.5, reps: 8 }] });
  await button(screen.tree, 'Save routine').props.onClick();
  assert.equal(findByClass(screen.tree, 'gym-plan-versions').length, 1);
  assert.equal(button(screen.tree, 'Save routine'), undefined);
  assert.equal(findByClass(screen.tree, 'gym-plan-version-columns').length, 1);
  await button(screen.tree, 'Keep both').props.onClick();
  assert.deepEqual(writes, [{ id: 'routine', write: { id: 'routine', name: 'My retained draft', position: 0, entries: [{ exerciseId: 'bench', sets: [{ reps: 8, weightKg: 62.5 }] }], revision: 1 } }]);
  assert.equal(copies.length, 1);
  assert.notEqual(copies[0].id, 'routine');
  assert.deepEqual(copies[0], { id: copies[0].id, name: 'My retained draft', position: 0, entries: [{ exerciseId: 'bench', sets: [{ reps: 8, weightKg: 62.5 }] }] });
});
