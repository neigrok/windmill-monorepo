import test from 'node:test';
import assert from 'node:assert/strict';
import { browserWith, confirmed, elementsOf, findByClass, gymAccount, loadScreen, renderHook, roomLog, settle, textOf } from '../harness.mjs';

test('a refused correction retains the native date and set draft, then permits retry or delete', async (t) => {
  browserWith();
  const startedAt = new Date(2026, 0, 7, 18, 5).getTime();
  const session = { id: 'ses_correction', startedAt, finishedAt: startedAt + 3600000, routineName: 'Push A' };
  const lifted = { exerciseId: 'bench-press', setNumber: 1, weightKg: 60, reps: 8, kind: 'working', completedAt: startedAt + 60000, note: '' };
  const set = { id: 'set_correction', ...lifted };
  // The next evening already holds a workout, so moving this one onto it crosses that one.
  const gym = await gymAccount(t, [
    confirmed('session', session.id, { startedAt, finishedAt: session.finishedAt, displayName: 'Push A' }),
    confirmed('set', set.id, { sessionId: session.id, ...lifted }),
    confirmed('session', 'sessionNext1', { startedAt: new Date(2026, 0, 8, 18, 30).getTime(), finishedAt: new Date(2026, 0, 8, 19, 30).getTime() }),
  ]);
  const { WorkoutEditor } = await loadScreen('products/gym/correction/WorkoutEditor.jsx');
  window.location.hash = '#/gym/log/ses_correction/edit';
  const view = renderHook(t, () => WorkoutEditor({
    session, sets: [set], catalog: [{ id: 'bench-press', name: 'Bench Press' }], log: roomLog(), from: '#/gym/log', onDelete: () => {},
  }));
  const field = (name) => elementsOf(view.tree).find((node) => node.type === 'input' && node.props.name === name);
  assert.deepEqual(findByClass(view.tree, 'gym-workout-local-value').map(textOf), ['7 Jan 2026', '18:05']);
  field('date').props.onChange({ target: { value: '2026-01-08' } });
  field('weightKg').props.onChange({ target: { value: '62.5' } });
  const save = findByClass(view.tree, 'gym-correction-form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(elementsOf(view.tree).find((node) => node.type === 'fieldset').props.disabled, true);
  assert.equal(findByClass(view.tree, 'gym-short-discard')[0].props.disabled, true);
  await save;
  assert.deepEqual(gym.owed(), [], 'the log took nothing');
  assert.equal(window.location.hash, '#/gym/log/ses_correction/edit', 'a refusal leaves the editor where it is');
  assert.equal(field('date').props.type, 'date');
  assert.equal(field('date').props.value, '2026-01-08');
  assert.equal(field('weightKg').props.value, '62.5');
  assert.deepEqual(findByClass(view.tree, 'gym-workout-local-value').map(textOf), ['8 Jan 2026', '18:05']);
  assert.equal(findByClass(view.tree, 'gym-short-discard')[0].props.disabled, false);
  assert.equal(textOf(findByClass(view.tree, 'gym-read-failed')[0]), 'these times cross a session already in the log');

  // The retry writes the draft the refusal kept.
  field('date').props.onChange({ target: { value: '2026-01-09' } });
  await findByClass(view.tree, 'gym-correction-form')[0].props.onSubmit({ preventDefault() {} });
  await settle();
  assert.deepEqual(gym.owed(), ['ready gym.correctSession ses_correction']);
  const { args } = gym.engine.device.activeReplica.entries()[0].intent.cmd;
  const moved = new Date(2026, 0, 9, 18, 5).getTime();
  assert.match(args.requestId, /^fix_[0-9a-f]{16}$/);
  assert.deepEqual(args, {
    sessionId: 'ses_correction', requestId: args.requestId, startedAt: moved, finishedAt: moved + 3600000, routineName: 'Push A',
    sets: [{ id: 'set_correction', exerciseId: 'bench-press', setNumber: 1, weightKg: 62.5, reps: 8, rpe: null, note: '', completedAt: moved + 60000 }],
  });
  assert.equal(window.location.hash, '#/gym/session/ses_correction?from=%23%2Fgym%2Flog');
});
