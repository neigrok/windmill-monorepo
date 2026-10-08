import test from 'node:test';
import assert from 'node:assert/strict';
import * as gymRuntime from '../../../../src/products/gym/gymRuntime.js';
import { applyPushResult, nextPush } from '../../../../../packages/api-contract/sync/reference/client/sender.js';
import { syncSession } from '../../../../src/platform/sync/session.js';
import { browserWith, confirmed, elementsOf, findByClass, gymAccount, loadScreen, renderHook, roomLog, settle, textOf } from '../harness.mjs';

async function answerWorkout(gym, refusal = null) {
  await gym.engine.write(null, (device, context) => {
    const replica = device.activeReplica;
    const request = nextPush(replica, context);
    assert.ok(request);
    const result = refusal ? { n: request.intents[0].n, s: 'refused', ...refusal } : { n: request.intents[0].n, s: 'ok', seq: 100 };
    const body = { epoch: replica.meta.serverEpoch, serverTime: Date.now(), lastN: result.n, results: [result] };
    gymRuntime.gymWorkoutResult(replica, context, result, body);
    applyPushResult(replica, context, result, body);
  }, ['self/gym']);
  await settle();
}

for (const future of [false, true]) test(`a ${future ? 'future' : 'known overlapping'} correction keeps its exact form and queues nothing`, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 24, 18).getTime() });
  browserWith();
  const session = { id: 'ses_correction', startedAt: new Date(2026, 8, 21, 18).getTime(), finishedAt: new Date(2026, 8, 21, 19).getTime() };
  const set = { id: 'set_correction', exerciseId: 'bench-press', setNumber: 1, weightKg: 60, reps: 8, kind: 'working', completedAt: session.startedAt + 60000 };
  const { id: setId, ...setFields } = set;
  const gym = await gymAccount(t, [confirmed('session', session.id, { startedAt: session.startedAt, finishedAt: session.finishedAt }),
    confirmed('set', setId, { ...setFields, sessionId: session.id }),
    confirmed('session', 'sessionOther', { startedAt: new Date(2026, 8, 22, 18).getTime(), finishedAt: new Date(2026, 8, 22, 19).getTime(), displayName: 'Legs' })]);
  const { WorkoutEditor } = await loadScreen('products/gym/correction/WorkoutEditor.jsx');
  const view = renderHook(t, () => WorkoutEditor({ session, sets: [set], catalog: [{ id: 'bench-press', name: 'Bench Press' }], log: roomLog(), from: '#/gym/log' }));
  const field = (name) => elementsOf(view.tree).find((node) => node.type === 'input' && node.props.name === name);
  window.location.hash = '#/gym/session/ses_correction/edit';
  field('date').props.onChange({ target: { value: future ? '2026-09-25' : '2026-09-22' } });
  field('weightKg').props.onChange({ target: { value: '062,500' } });
  await findByClass(view.tree, 'gym-correction-form')[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(gym.owed(), []);
  assert.equal(window.location.hash, '#/gym/session/ses_correction/edit');
  assert.equal(field('weightKg').props.value, '062,500');
  assert.equal(field('date').props.value, future ? '2026-09-25' : '2026-09-22');
  assert.match(textOf(findByClass(view.tree, 'gym-read-failed')[0]), future ? /past now/ : /cross a workout/);
});

test('a late correction refusal restores literal input after remount and waits for successful retry admission', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 24, 18).getTime() });
  browserWith();
  const session = { id: 'ses_correction', startedAt: new Date(2026, 8, 21, 18, 0, 23).getTime(), finishedAt: new Date(2026, 8, 21, 19, 0, 23).getTime() };
  const set = { id: 'set_correction', exerciseId: 'bench-press', setNumber: 1, weightKg: 60, reps: 8, kind: 'drop', rpe: 8.5, note: 'Exact note', completedAt: session.startedAt + 60000 };
  const { id: setId, ...setFields } = set;
  const gym = await gymAccount(t, [confirmed('session', session.id, { startedAt: session.startedAt, finishedAt: session.finishedAt }), confirmed('set', setId, { ...setFields, sessionId: session.id })]);
  const { WorkoutEditor } = await loadScreen('products/gym/correction/WorkoutEditor.jsx');
  const mount = () => renderHook(t, () => WorkoutEditor({ session, sets: [set], catalog: [{ id: 'bench-press', name: 'Bench Press' }], log: roomLog(), from: '#/gym/log' }));
  let view = mount();
  const field = (name) => elementsOf(view.tree).find((node) => node.type === 'input' && node.props.name === name);
  const submit = () => findByClass(view.tree, 'gym-correction-form')[0].props.onSubmit({ preventDefault() {} });
  window.location.hash = '#/gym/session/ses_correction/edit';
  field('date').props.onChange({ target: { value: '2026-09-22' } });
  field('weightKg').props.onChange({ target: { value: '062,500' } });
  field('routineName').props.onChange({ target: { value: '  Exact workout  ' } });
  await submit();
  view.redraw();
  assert.equal(window.location.hash, '#/gym/session/ses_correction/edit');
  assert.equal(elementsOf(view.tree).find((node) => node.type === 'fieldset').props.disabled, true);
  assert.equal(elementsOf(view.tree).find((node) => node.type?.name === 'Button').props.children, 'Waiting for the log…');
  const active = syncSession.getSnapshot();
  const suspended = t.mock.method(syncSession, 'getSnapshot', () => ({ ...active, ready: false }));
  view.redraw();
  assert.equal(elementsOf(view.tree).find((node) => node.type === 'fieldset').props.disabled, true);
  assert.equal(field('weightKg').props.value, '062,500');
  suspended.mock.restore();
  view.redraw();
  assert.equal(elementsOf(view.tree).find((node) => node.type?.name === 'Button').props.children, 'Waiting for the log…');
  await submit();
  assert.equal(gym.owed().length, 1);
  view.unmount();
  view = mount();
  assert.deepEqual([field('date').props.value, field('weightKg').props.value, field('routineName').props.value], ['2026-09-22', '062,500', '  Exact workout  ']);
  await gym.land(confirmed('session', 'sessionRaced', { startedAt: new Date(2026, 8, 22, 18).getTime(), finishedAt: new Date(2026, 8, 22, 19).getTime(), displayName: 'Legs' }));
  await answerWorkout(gym, { code: 'session-overlap', detail: { sessionId: 'sessionRaced' } });
  view.redraw();
  assert.equal(window.location.hash, '#/gym/session/ses_correction/edit');
  assert.equal(elementsOf(view.tree).find((node) => node.type === 'fieldset').props.disabled, false);
  assert.equal(elementsOf(view.tree).find((node) => node.type === 'a' && node.props.href === '#/gym/session/sessionRaced')?.props.children, 'Open that session');
  view.unmount();
  view = mount();
  assert.deepEqual([field('date').props.value, field('weightKg').props.value, field('routineName').props.value], ['2026-09-22', '062,500', '  Exact workout  ']);
  field('date').props.onChange({ target: { value: '2026-09-23' } });
  field('weightKg').props.onChange({ target: { value: '065,000' } });
  view.redraw();
  assert.equal(field('weightKg').props.value, '065,000');
  await submit();
  view.redraw();
  assert.equal(window.location.hash, '#/gym/session/ses_correction/edit');
  await answerWorkout(gym);
  view.redraw();
  assert.equal(window.location.hash, '#/gym/session/ses_correction?from=%23%2Fgym%2Flog');
});

test('a failed correction retains the native date and set draft, then permits retry or delete', async (t) => {
  browserWith();
  const startedAt = new Date(2026, 0, 7, 18, 5).getTime();
  const session = { id: 'ses_correction', startedAt, finishedAt: startedAt + 3600000, routineName: 'Push A' };
  const lifted = { exerciseId: 'bench-press', setNumber: 1, weightKg: 60, reps: 8, kind: 'working', completedAt: startedAt + 60000, note: '' };
  const set = { id: 'set_correction', ...lifted };
  const gym = await gymAccount(t, [
    confirmed('session', session.id, { startedAt, finishedAt: session.finishedAt, displayName: 'Push A' }),
    confirmed('set', set.id, { sessionId: session.id, ...lifted }),
  ]);
  const transact = gym.engine.store.transact.bind(gym.engine.store);
  let refusing = true;
  gym.engine.store.transact = (change, options = {}) => refusing && !options.readonly
    ? transact((device) => { change(device); throw new DOMException('storage refused', 'QuotaExceededError'); }, options)
    : transact(change, options);
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
  assert.equal(textOf(findByClass(view.tree, 'gym-read-failed')[0]), 'Those changes didn’t land — this device couldn’t store it.');

  // The retry writes the draft the refusal kept.
  refusing = false;
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
  assert.equal(window.location.hash, '#/gym/log/ses_correction/edit');
  await answerWorkout(gym);
  view.redraw();
  assert.equal(window.location.hash, '#/gym/session/ses_correction?from=%23%2Fgym%2Flog');
});

test('a correction form never adopts another tab’s command result', async (t) => {
  browserWith();
  const startedAt = new Date(2026, 0, 7, 18).getTime();
  const session = { id: 'ses_correction', startedAt, finishedAt: startedAt + 3600000 };
  const set = { id: 'set_correction', exerciseId: 'bench-press', setNumber: 1, weightKg: 60, reps: 8, kind: 'working', completedAt: startedAt + 60000 };
  const { id: setId, ...setFields } = set;
  const gym = await gymAccount(t, [confirmed('session', session.id, { startedAt, finishedAt: session.finishedAt }), confirmed('set', setId, { ...setFields, sessionId: session.id })]);
  const { WorkoutEditor } = await loadScreen('products/gym/correction/WorkoutEditor.jsx');
  const mount = () => renderHook(t, () => WorkoutEditor({ session, sets: [set], catalog: [], log: roomLog(), from: '#/gym/log' }));
  const first = mount();
  const second = mount();
  const field = (view, name) => elementsOf(view.tree).find((node) => node.type === 'input' && node.props.name === name);
  window.location.hash = '#/gym/session/ses_correction/edit';
  field(first, 'routineName').props.onChange({ target: { value: 'First tab' } });
  field(second, 'routineName').props.onChange({ target: { value: '  Second tab  ' } });
  await findByClass(first.tree, 'gym-correction-form')[0].props.onSubmit({ preventDefault() {} });
  await findByClass(second.tree, 'gym-correction-form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(gym.owed().length, 1);
  assert.match(textOf(findByClass(second.tree, 'gym-read-failed')[0]), /still waiting/);
  first.unmount();
  await answerWorkout(gym);
  second.redraw();
  assert.equal(window.location.hash, '#/gym/session/ses_correction/edit');
  assert.equal(field(second, 'routineName').props.value, '  Second tab  ');
  assert.equal(elementsOf(second.tree).find((node) => node.type === 'fieldset').props.disabled, false);
  await findByClass(second.tree, 'gym-correction-form')[0].props.onSubmit({ preventDefault() {} });
  window.location.hash = '#/gym/notes';
  await answerWorkout(gym);
  second.redraw();
  assert.equal(window.location.hash, '#/gym/notes', 'a result arriving before unmount does not undo a navigation');
});

test('a deleted workout still opens its refused correction draft from the recovery route', async (t) => {
  browserWith();
  const startedAt = new Date(2026, 0, 7, 18).getTime();
  const session = { id: 'ses_correction', startedAt, finishedAt: startedAt + 3600000 };
  const stored = confirmed('session', session.id, { startedAt, finishedAt: session.finishedAt });
  const set = { id: 'set_correction', exerciseId: 'bench-press', setNumber: 1, weightKg: 60, reps: 8, kind: 'working', completedAt: startedAt + 60000 };
  const { id: setId, ...setFields } = set;
  const gym = await gymAccount(t, [stored, confirmed('set', setId, { ...setFields, sessionId: session.id })]);
  const { WorkoutEditor } = await loadScreen('products/gym/correction/WorkoutEditor.jsx');
  const log = roomLog();
  let view = renderHook(t, () => WorkoutEditor({ session, sets: [set], catalog: [], log, from: '#/gym/log' }));
  const field = (name) => elementsOf(view.tree).find((node) => node.type === 'input' && node.props.name === name);
  window.location.hash = '#/gym/session/ses_correction/edit';
  field('date').props.onChange({ target: { value: '2026-01-08' } });
  field('routineName').props.onChange({ target: { value: '  Saved draft  ' } });
  await findByClass(view.tree, 'gym-correction-form')[0].props.onSubmit({ preventDefault() {} });
  view.unmount();
  await gym.land({ ...stored, life: ['dead', '2:0:srv'], seq: 100 });
  await answerWorkout(gym, { code: 'record-dead' });
  const { SessionDetail } = await loadScreen('products/gym/Log.jsx');
  const route = renderHook(t, () => SessionDetail({ id: session.id, edit: true, log }));
  await settle();
  assert.equal(route.tree.type?.name, 'WorkoutEditor');
  view = renderHook(t, () => route.tree.type(route.tree.props));
  assert.deepEqual([field('date').props.value, field('routineName').props.value], ['2026-01-08', '  Saved draft  ']);
  assert.equal(textOf(findByClass(view.tree, 'gym-read-failed')[0]), 'This workout is no longer in the log. Your edits are still here.');
  field('routineName').props.onChange({ target: { value: 'I can still copy these edits' } });
  await findByClass(view.tree, 'gym-correction-form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(field('routineName').props.value, 'I can still copy these edits');
  assert.equal(window.location.hash, '#/gym/session/ses_correction/edit');
  assert.deepEqual(gym.owed(), []);
});
