import test from 'node:test';
import assert from 'node:assert/strict';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, textOf } from '../harness.mjs';

test('a refused correction retains the native date and set draft, then permits retry or delete', async (t) => {
  browserWith();
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  let refuse;
  const writes = [];
  global.fetch = async (url, options) => {
    writes.push({ url, body: JSON.parse(options.body) });
    await new Promise((resolve) => { refuse = resolve; });
    return { ok: false, status: 500, json: async () => ({ error: 'internal error' }) };
  };
  const { WorkoutEditor } = await loadScreen('products/gym/correction/WorkoutEditor.jsx');
  const startedAt = new Date(2026, 0, 7, 18, 5).getTime();
  const view = renderHook(t, () => WorkoutEditor({
    session: { id: 'ses_correction', startedAt, finishedAt: startedAt + 3600000, routineName: 'Push A' },
    sets: [{ id: 'set_correction', exerciseId: 'bench-press', weightKg: 60, reps: 8, kind: 'working', completedAt: startedAt + 60000 }],
    catalog: [{ id: 'bench-press', name: 'Bench Press' }],
    log: { reloadLog: async () => assert.fail('a refusal must not reload the saved workout') },
    from: '#/gym/log', onDelete: () => {},
  }));
  const field = (name) => elementsOf(view.tree).find((node) => node.type === 'input' && node.props.name === name);
  assert.deepEqual(findByClass(view.tree, 'gym-workout-local-value').map(textOf), ['7 Jan 2026', '18:05']);
  field('date').props.onChange({ target: { value: '2026-01-08' } });
  field('weightKg').props.onChange({ target: { value: '62.5' } });
  const save = findByClass(view.tree, 'gym-correction-form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(elementsOf(view.tree).find((node) => node.type === 'fieldset').props.disabled, true);
  assert.equal(findByClass(view.tree, 'gym-short-discard')[0].props.disabled, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.startedAt, new Date(2026, 0, 8, 18, 5).getTime());
  assert.equal(writes[0].body.sets[0].weightKg, 62.5);
  refuse();
  await save;
  assert.equal(field('date').props.type, 'date');
  assert.equal(field('date').props.value, '2026-01-08');
  assert.equal(field('weightKg').props.value, '62.5');
  assert.deepEqual(findByClass(view.tree, 'gym-workout-local-value').map(textOf), ['8 Jan 2026', '18:05']);
  assert.equal(findByClass(view.tree, 'gym-short-discard')[0].props.disabled, false);
  assert.equal(textOf(findByClass(view.tree, 'gym-read-failed')[0]), 'internal error');
});
