import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { registry } from '../../../src/platform/sync/schema.js';
import { environment, until } from '../../platform/sync/fakes.js';
import { hello } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { GymRefusal, isStoreFailure } from '../../../src/products/gym/errors.js';
import { Note } from '../../../src/products/gym/domain/notes.js';
import { createGymApi, gymLiveHint } from '../../../src/products/gym/gymSync.js';

async function open(t) {
  const env = environment();
  env.options.registry = registry;
  env.transport.request = async () => ({ response: hello({ state: env.state, registry, account: 'A', serverTime: env.timers.time }), timing: {
    send: { wall: env.timers.time, mono: env.timers.time, boot: 'test' }, recv: { wall: env.timers.time, mono: env.timers.time, boot: 'test' },
  } });
  let engine = await BrowserSyncEngine.open(env.options);
  assert.equal((await engine.signIn('A')).complete, true);
  const events = [], failures = [];
  const api = createGymApi(engine, { event: (operation, outcome) => events.push({ operation, outcome }), failure: (operation) => failures.push(operation) });
  t.after(() => engine.close());
  return { env, get engine() { return engine; }, api, events, failures, reopen: async () => { engine.close(); engine = await BrowserSyncEngine.open(env.options); return createGymApi(engine); } };
}
async function confirm(engine) {
  const rows = engine.observe('self/gym').getSnapshot().stored;
  await engine.write(null, (device) => {
    const replica = device.activeReplica;
    replica.outbox = [];
    rows.forEach((row, index) => replica.putConfirmed('self/gym', { ...row, rc: 1000, ru: 1000, seq: index + 1 }));
  }, ['self/gym']);
}
const routine = { id: 'routine00001', name: 'Lower A', position: 0, entries: [{ exerciseId: 'back-squat', sets: [{ reps: 5, weightKg: 60 }, { reps: 3, weightKg: 80 }] }] };

test('a malformed stored plan preserves the session and reports through the API failure boundary', async (t) => {
  const { api, engine, failures, events } = await open(t);
  const row = { t: 'session', id: 'sessionPrivate', seq: 1, born: '1000:0:srv', life: ['alive', '1000:0:srv'],
    f: { startedAt: [1000, '1000:0:srv'], finishedAt: [2000, '1000:0:srv'], plan: [{ routine: 42, entries: [] }, '1000:0:srv'] } };
  await engine.write(null, (device) => device.activeReplica.putConfirmed('self/gym', row), ['self/gym']);
  assert.deepEqual(await api.session(row.id), { session: { id: row.id, startedAt: 1000, finishedAt: 2000 }, sets: [] });
  assert.deepEqual(failures, ['projection']);
  assert.deepEqual(events, []);
  assert.deepEqual(engine.device.activeReplica.outbox, []);
  assert.deepEqual(engine.observe('self/gym').getSnapshot().stored[0].f.plan, row.f.plan);
});

test('authoritative gym fields and independent routine creation snapshots survive persisted engine restart', async (t) => {
  const opened = await open(t);
  const { api, engine, reopen } = opened;
  assert.equal(registry.version, 6);
  assert.equal(registry.minVersion, 4);
  const receipt = { id: routine.id, name: 'Original lower', position: 0, revision: 1, entries: [{ position: 1, exerciseId: 'bench-press' }] };
  const rows = [
    { t: 'routine', id: routine.id, born: '1000:0:srv', life: ['alive', '1000:0:srv'], fields: { name: routine.name, position: routine.position, entries: routine.entries, revision: 7, createdEntries: 3 } },
    { t: 'routineCreation', id: routine.id, fields: { snapshot: receipt } },
    { t: 'proposal', id: 'proposal0001', born: '1000:0:srv', life: ['alive', '1000:0:srv'], fields: { routineId: routine.id, baseRevision: 6, baseName: 'Frozen lower', changeCount: 2, intent: 'revise', proposedName: 'Next lower', door: 'ask', changes: [] } },
    { t: 'note', id: 'note000001', born: '1000:0:srv', life: ['alive', '1000:0:srv'], fields: { title: 'First', body: '', ord: 'a0', updatedAt: 500 } },
  ].map(({ fields, ...row }, index) => ({ ...row, rc: 1000, ru: 2000, seq: index + 1,
    f: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, [value, '1000:0:srv']])) }));
  await engine.write(null, (device) => rows.forEach((row) => device.activeReplica.putConfirmed('self/gym', row)), ['self/gym']);
  const original = await api.routine(routine.id);
  assert.equal(original.revision, 7);
  assert.equal(original.history.at(-1).movements, 3);
  assert.equal(original.pendingProposal.changeCount, 2);
  await api.replaceRoutine(routine.id, { ...original, name: 'Edited lower', createdEntries: 999 }, original);
  await api.saveNote('note000001', { title: 'Edited', body: '', updatedAt: 999 }, (await api.notes())[0]);
  const deltas = engine.device.activeReplica.entries().flatMap((entry) => entry.intent.d);
  assert.deepEqual(deltas.map(({ t, f }) => ({ t, fields: Object.keys(f).sort() })), [
    { t: 'routine', fields: ['name'] }, { t: 'note', fields: ['title'] },
  ]);
  const pending = structuredClone(engine.device.activeReplica.outbox);
  for (const [type, id, field, value] of [
    ['routine', routine.id, 'revision', 999], ['routine', routine.id, 'createdEntries', 999],
    ['proposal', 'proposal0001', 'baseRevision', 999], ['proposal', 'proposal0001', 'baseName', 'Forged'],
    ['proposal', 'proposal0001', 'changeCount', 999], ['note', 'note000001', 'updatedAt', 999],
    ['routineCreation', routine.id, 'snapshot', {}],
  ]) {
    await assert.rejects(engine.commit('self/gym', [{ op: type === 'routineCreation' ? 'write' : 'update', t: type, id, f: { [field]: value } }]), /written by the server/);
    assert.deepEqual(engine.device.activeReplica.outbox, pending);
  }
  const resumed = await reopen();
  const saved = await resumed.routine(routine.id);
  assert.equal(saved.revision, 7);
  assert.deepEqual(saved.history.at(-1), { kind: 'created', at: 1000, movements: 3 });
  const proposal = await resumed.proposal('proposal0001');
  assert.deepEqual({ baseRevision: proposal.baseRevision, baseName: proposal.baseName, changeCount: proposal.changeCount }, { baseRevision: 6, baseName: 'Frozen lower', changeCount: 2 });
  assert.deepEqual((await resumed.notes()).map(({ id, position, title, body, updatedAt }) => ({ id, position, title, body, updatedAt })), [{ id: 'note000001', position: 0, title: 'Edited', body: '', updatedAt: 500 }]);
  await resumed.holdDeath('routine', routine.id);
  assert.equal(opened.engine.observe('self/gym').getSnapshot().drawn.find((row) => row.t === 'routine').life[0], 'dead');
  assert.equal((await resumed.routine(routine.id)).id, routine.id, 'a held delete stays in the store until its release');
  assert.equal(registry.type('routineCreation').field('snapshot').writer, 'server');
  assert.deepEqual(opened.engine.observe('self/gym').getSnapshot().drawn.find((row) => row.t === 'routineCreation').f.snapshot[0], receipt);
  assert.equal(opened.engine.device.activeReplica.outbox.some((entry) => entry.intent.d.some((delta) => delta.t === 'routineCreation')), false);
});

test('routine saves persist schemes and guards; stale bases refuse without partial work', async (t) => {
  const { api, engine, failures } = await open(t);
  await api.createRoutine(routine);
  const base = await api.routine(routine.id);
  assert.deepEqual(base.entries[0].sets, routine.entries[0].sets);
  await api.replaceRoutine(routine.id, { ...routine, name: 'Lower B' }, base);
  assert.deepEqual(engine.device.activeReplica.entries()[1].intent.guard.map(({ field }) => field).sort(), ['name']);
  const before = structuredClone(engine.device.activeReplica.outbox);
  await assert.rejects(api.replaceRoutine(routine.id, { ...routine, name: 'Stale' }, base), { code: 'stale' });
  assert.deepEqual(engine.device.activeReplica.outbox, before);
  assert.deepEqual(failures, []);
});

test('notes append; a move writes only the moved note order register', async (t) => {
  const { api, engine } = await open(t);
  for (let n = 1; n <= 3; n++) await api.saveNote(`note00000${n}`, { title: String(n), body: '' });
  assert.deepEqual((await api.notes()).map(({ id }) => id), ['note000001', 'note000002', 'note000003']);
  await confirm(engine);
  assert.deepEqual((await api.moveNote('note000002', 'note000003')).map(({ id, position }) => [id, position]),
    [['note000001', 0], ['note000003', 1], ['note000002', 2]]);
  assert.deepEqual((await api.notes()).map(({ id }) => id), ['note000001', 'note000003', 'note000002']);
  const [delta] = engine.device.activeReplica.entries().at(-1).intent.d;
  assert.deepEqual([delta.id, Object.keys(delta.f)], ['note000002', ['ord']]);
  await api.moveNote('note000003', null);
  assert.deepEqual((await api.notes()).map(({ id }) => id), ['note000003', 'note000001', 'note000002']);
  const before = structuredClone(engine.device.activeReplica.outbox);
  await assert.rejects(api.moveNote('note000099', null), { code: 'record-dead' });
  await assert.rejects(api.moveNote('note000001', 'note000099'), { code: 'record-dead' });
  assert.deepEqual(engine.device.activeReplica.outbox, before);
});

test('note editor guards refuse changed content and preserve the original local draft', async (t) => {
  const { api, engine } = await open(t);
  await api.saveNote('note000001', { title: 'First', body: 'Context' });
  await confirm(engine);
  const base = (await api.notes())[0];
  await api.saveNote('note000001', { title: 'First', body: 'Changed' }, base);
  await assert.rejects(api.saveNote('note000001', { title: 'First', body: 'Stale' }, base), { code: 'stale' });
  assert.deepEqual(engine.device.activeReplica.entries().at(-1).intent.guard.map(({ field }) => field), ['body']);
});

test('held deaths survive process exit; Undo restores the drawn row', async (t) => {
  const { api, engine, reopen } = await open(t);
  await api.saveNote('note000001', { title: 'First', body: '' });
  const gesture = await api.holdDeath('note', 'note000001');
  assert.equal(engine.device.activeReplica.entries().at(-1).state, 'held');
  assert.equal(engine.observe('self/gym').getSnapshot().drawn[0].life[0], 'dead');
  assert.equal((await api.notes()).length, 0);
  assert.equal(api.read((read) => read.repository(Note).capacity().used), 1);
  const resumed = await reopen();
  assert.equal(await resumed.undoDeath(gesture), true);
  assert.equal((await resumed.notes())[0].title, 'First');
});

test('account polls and focus refreshes keep a gym delete held for its full nine seconds', async (t) => {
  const { api, engine, env } = await open(t);
  const endpoints = [], request = env.transport.request;
  env.transport.request = (...args) => { endpoints.push(args[0]); return request(...args); };
  await engine.start(); await until(() => engine.leader);
  await api.saveNote('note000001', { title: 'First', body: '' }); await confirm(engine);
  const first = await api.holdDeath('note', 'note000001');
  env.timers.advance(4000);
  for (let n = 0; n < 3; n++) {
    await engine.signIn('A'); await engine.send();
    assert.equal(engine.device.activeReplica.entries().at(-1).state, 'held');
  }
  assert.equal(endpoints.includes('push'), false);
  assert.equal(await api.undoDeath(first), true);
  await api.holdDeath('note', 'note000001');
  env.timers.advance(8999); await engine.signIn('A'); await engine.send();
  assert.equal(engine.device.activeReplica.entries().at(-1).state, 'held');
  assert.equal(endpoints.includes('push'), false);
  env.timers.advance(1);
  await until(() => engine.device.activeReplica.entries().at(-1).state === 'ready');
});

test('held note deaths occupy the cap slot and allow siblings to reorder', async (t) => {
  const { api } = await open(t);
  for (let n = 0; n < 10; n++) await api.saveNote(`note0000${String(n).padStart(2, '0')}`, { title: String(n), body: '' });
  await api.holdDeath('note', 'note000000');
  const order = (await api.notes()).map(({ id }) => id);
  [order[0], order[1]] = [order[1], order[0]];
  await api.moveNote('note000002', 'note000000');
  assert.deepEqual((await api.notes()).map(({ id }) => id), order);
  await assert.rejects(api.saveNote('note000099', { title: 'Extra', body: '' }), { code: 'cap', sentence: '10 of 10 notes. Delete one to add another.' });
});

test('weigh-in puts use the transaction clock and atomically retire a held death', async (t) => {
  const { api, engine, env } = await open(t);
  await api.saveBodyweight('1970-01-01', { weightKg: 80.25, recordedAt: 999999 });
  await api.holdDeath('weighin', '1970-01-01');
  env.timers.advance(100);
  const entry = await api.saveBodyweight('1970-01-01', { weightKg: 81, recordedAt: 1 });
  assert.equal(entry.recordedAt, env.timers.time);
  assert.equal(engine.device.activeReplica.outbox.some((entry) => entry.state === 'held'), false);
  assert.deepEqual((await api.bodyweight()).latest, entry);
});

test('imports and corrections use atomic commands; offline reload retains the pending workout', async (t) => {
  const { api, engine, reopen } = await open(t);
  const imported = { id: 'session00001', startedAt: 100, finishedAt: 900, sets: [{ id: 'set00000001', exerciseId: 'bench-press', weightKg: 60, reps: 5, completedAt: 850 }] };
  await api.importSession(imported);
  assert.deepEqual(engine.device.activeReplica.entries().at(-1).intent.cmd, { name: 'gym.importSession', args: imported });
  const resumed = await reopen();
  assert.equal((await resumed.session(imported.id)).sets[0].reps, 5);
  assert.equal((await resumed.session(imported.id)).sets[0].setNumber, 1);
  await resumed.correctSession(imported.id, { requestId: 'request00001', startedAt: 100, finishedAt: 900, routineName: 'Bench', sets: [{ ...imported.sets[0], setNumber: 1, reps: 6 }] });
  assert.equal((await resumed.session(imported.id)).sets[0].reps, 6);
  for (const method of ['start', 'finish', 'logSet']) assert.equal(api[method], undefined);
});

test('offline corrections retain only named sets and their replacement serial numbers after restart', async (t) => {
  const { api, engine, reopen } = await open(t);
  const sets = [
    { id: 'set00000001', exerciseId: 'bench-press', weightKg: 60, reps: 5, completedAt: 600 },
    { id: 'set00000002', exerciseId: 'back-squat', weightKg: 80, reps: 5, completedAt: 700 },
    { id: 'set00000003', exerciseId: 'bench-press', weightKg: 65, reps: 5, completedAt: 800 },
  ];
  await api.importSession({ id: 'session00001', startedAt: 100, finishedAt: 900, sets });
  assert.deepEqual((await api.session('session00001')).sets.map(({ id, setNumber }) => ({ id, setNumber })), [
    { id: 'set00000001', setNumber: 1 }, { id: 'set00000002', setNumber: 1 }, { id: 'set00000003', setNumber: 2 },
  ]);
  await confirm(engine);
  await api.correctSession('session00001', { requestId: 'request00001', startedAt: 100, finishedAt: 900,
    routineName: 'Corrected', sets: [{ ...sets[2], setNumber: 1, reps: 6 }] });
  const resumed = await reopen();
  assert.deepEqual(await resumed.session('session00001'), {
    session: { id: 'session00001', startedAt: 100, finishedAt: 900, routineName: 'Corrected' },
    sets: [{ id: 'set00000003', exerciseId: 'bench-press', setNumber: 1, weightKg: 65, reps: 6, kind: 'working', note: '', completedAt: 800 }],
  });
});

test('additive corrections retain unnamed sets and exact kinds through offline restart', async (t) => {
  const opened = await open(t);
  const { api, engine, reopen } = opened;
  const existing = { id: 'set00000001', exerciseId: 'bench-press', weightKg: 60, reps: 5, completedAt: 600, kind: 'drop' };
  const unnamed = { id: 'set00000002', exerciseId: 'bench-press', weightKg: 80, reps: 3, completedAt: 700, kind: 'failure', note: 'Kept', rpe: 9 };
  await api.importSession({ id: 'session00001', startedAt: 100, finishedAt: 900, sets: [existing, unnamed] });
  await confirm(engine);
  const before = engine.observe('self/gym').getSnapshot().drawn.find((row) => row.id === unnamed.id);
  const added = { id: 'set00000003', exerciseId: 'bench-press', setNumber: 3, weightKg: 40, reps: 8, completedAt: 800, kind: 'warmup', note: 'Recovered', rpe: 6 };
  await api.correctSession('session00001', { requestId: 'request00001', startedAt: 100, finishedAt: 900,
    routineName: 'Kept', sets: [{ ...existing, setNumber: 1, kind: 'failure' }, added], preserveOtherSets: true });
  const resumed = await reopen();
  const { sets } = await resumed.session('session00001');
  assert.deepEqual(sets.map(({ id, kind }) => ({ id, kind })), [
    { id: existing.id, kind: 'drop' }, { id: unnamed.id, kind: 'failure' }, { id: added.id, kind: 'warmup' },
  ]);
  assert.deepEqual(sets.find((set) => set.id === added.id), added);
  assert.deepEqual(opened.engine.observe('self/gym').getSnapshot().drawn.find((row) => row.id === unnamed.id), before);
});

test('additive correction refuses collisions and intervals excluding retained sets without partial work', async (t) => {
  const { api, engine } = await open(t);
  await api.importSession({ id: 'session00001', startedAt: 100, finishedAt: 900,
    sets: [{ id: 'set00000001', exerciseId: 'bench-press', weightKg: 60, reps: 5, completedAt: 600 }] });
  await confirm(engine);
  const before = structuredClone(engine.device.activeReplica.outbox);
  const correction = { requestId: 'request00001', startedAt: 100, finishedAt: 900, routineName: '', preserveOtherSets: true,
    sets: [{ id: 'set00000002', exerciseId: 'bench-press', setNumber: 1, weightKg: 60, reps: 5, completedAt: 800 }] };
  await assert.rejects(api.correctSession('session00001', correction), { code: 'invalid' });
  correction.startedAt = 700;
  correction.sets[0].setNumber = 2;
  await assert.rejects(api.correctSession('session00001', correction), { code: 'bad-instant' });
  assert.deepEqual(engine.device.activeReplica.outbox, before);
  assert.equal((await api.session('session00001')).sets.length, 1);
});

test('an offline removal proposal hides its routine durably before the authoritative pull', async (t) => {
  const { api, engine, reopen } = await open(t);
  await api.createRoutine(routine);
  await confirm(engine);
  await engine.write(null, (device) => device.activeReplica.putConfirmed('self/gym', {
    t: 'proposal', id: 'proposal0001', born: '1000:0:srv', life: ['alive', '1000:0:srv'], rc: 1000, ru: 1000, seq: 2,
    f: Object.fromEntries(Object.entries({ routineId: routine.id, intent: 'remove', proposedName: routine.name,
      summary: 'Remove', door: 'ask', changes: [] }).map(([field, value]) => [field, [value, '1000:0:srv']])),
  }), ['self/gym']);
  await api.applyProposal('proposal0001');
  const resumed = await reopen();
  assert.equal(await resumed.routine(routine.id), null);
  assert.deepEqual(await resumed.routines(), []);
  const proposal = await resumed.proposal('proposal0001');
  assert.deepEqual({ state: proposal.state, removalOutcome: proposal.removalOutcome }, { state: 'pending', removalOutcome: 'pending' });
});

test('a store that cannot commit leaves no partial write, is the device’s failure, and the engine alone reports it', async (t) => {
  const { api, engine, env, failures, events } = await open(t);
  t.mock.method(engine.store, 'transact', async () => { throw new Error('SECRET workout'); });
  await assert.rejects(api.createRoutine(routine), (error) => isStoreFailure(error) && error.message === 'the device store did not commit');
  assert.deepEqual(engine.device.activeReplica.outbox, []);
  assert.deepEqual(failures, []);
  assert.deepEqual(env.failures, ['storage']);
  assert.deepEqual(events, [{ operation: 'routine-create', outcome: 'failed' }]);
});

// What each display-name write commits: the record and the name it writes.
const namesWritten = (engine) => engine.device.activeReplica.entries()
  .flatMap(({ intent }) => intent.d.map(({ t, id, f }) => [t, id, f.name?.[0] ?? f.title?.[0]]));

test('a rename writes the name trimmed and composed, and a blank one is refused before anything is written', async (t) => {
  const { api, engine, events, failures } = await open(t);
  assert.deepEqual(await api.renameExercise('back-squat', '  Cafe\u0301 squat\u3000'),
    { id: 'back-squat', name: 'Café squat', pattern: 'squat', equipment: 'barbell', stepKg: 2.5, custom: false });
  assert.deepEqual(namesWritten(engine), [['exerciseName', 'back-squat', 'Café squat']]);
  for (const blank of ['   ', ' \u3000', '\u00a0\u3000\t', '\u2028\ufeff']) {
    await assert.rejects(api.renameExercise('back-squat', blank),
      (error) => error instanceof GymRefusal && error.code === 'invalid' && error.sentence === 'A movement needs a name.');
  }
  await assert.rejects(api.renameExercise('back-squat', 'ü'.repeat(61)),
    (error) => error instanceof GymRefusal && error.code === 'invalid' && error.sentence === 'A name runs to 60 characters.');
  assert.deepEqual(namesWritten(engine), [['exerciseName', 'back-squat', 'Café squat']], 'nothing refused was written');
  assert.deepEqual(events.map(({ outcome }) => outcome), ['saved-local', 'refused', 'refused', 'refused', 'refused', 'refused']);
  assert.deepEqual(failures, [], 'a refusal is expected, and reports nothing');
});

test('a rename to the name the store already holds writes nothing; an unknown movement is refused', async (t) => {
  const { api, engine, events } = await open(t);
  assert.deepEqual(await api.renameExercise('back-squat', ' Back Squat '),
    { id: 'back-squat', name: 'Back Squat', pattern: 'squat', equipment: 'barbell', stepKg: 2.5, custom: false });
  await assert.rejects(api.renameExercise('ex_unknown', 'New'), (error) => error instanceof GymRefusal && error.code === 'record-dead');
  assert.deepEqual(engine.device.activeReplica.outbox, []);
  assert.deepEqual(events, [{ operation: 'exercise-rename', outcome: 'unchanged' }, { operation: 'exercise-rename', outcome: 'refused' }]);
});

test('a movement, a routine and a note are each created with their name trimmed, and none is written blank', async (t) => {
  const { api, engine } = await open(t);
  await api.createExercise({ id: 'ex_custom01', name: ' Zercher squat ', pattern: 'isolation', equipment: 'barbell' });
  await api.renameExercise('ex_custom01', ' Zercher ');
  await api.createRoutine({ ...routine, name: '\u3000Lower A ' });
  await api.replaceRoutine(routine.id, { ...routine, name: ' Lower B' }, await api.routine(routine.id));
  await api.saveNote('note000001', { title: ' First\u00a0', body: '' });
  const refusals = [
    [() => api.createExercise({ id: 'ex_custom02', name: '\u3000', pattern: 'isolation', equipment: 'barbell' }), 'A movement needs a name.'],
    [() => api.createRoutine({ ...routine, id: 'routine00002', name: ' \t ' }), 'Name it to save it.'],
    [async () => api.replaceRoutine(routine.id, { ...routine, name: '\u00a0' }, await api.routine(routine.id)), 'Name it to save it.'],
    [() => api.saveNote('note000002', { title: '\u3000 ', body: '' }), 'a note needs a title'],
  ];
  for (const [write, sentence] of refusals) {
    await assert.rejects(write(), (error) => error instanceof GymRefusal && error.code === 'invalid' && error.sentence === sentence);
  }
  assert.deepEqual(namesWritten(engine), [
    ['exercise', 'ex_custom01', 'Zercher squat'],
    ['exercise', 'ex_custom01', 'Zercher'],
    ['routine', 'routine00001', 'Lower A'],
    ['routine', 'routine00001', 'Lower B'],
    ['note', 'note000001', 'First'],
  ]);
});

test('custom exercise creation preserves a supplied step and validates it before committing', async (t) => {
  const { api, engine, events, failures } = await open(t);
  assert.deepEqual(await api.createExercise({ id: 'ex_custom01', name: 'Carry', pattern: 'carry', equipment: 'dumbbell', stepKg: 2.125 }),
    { id: 'ex_custom01', name: 'Carry', pattern: 'carry', equipment: 'dumbbell', stepKg: 2.13, aliases: [], custom: true });
  const before = structuredClone(engine.device.activeReplica.outbox);
  await assert.rejects(api.createExercise({ id: 'ex_custom02', name: 'Carry', pattern: 'carry', equipment: 'dumbbell', stepKg: 0 }), { code: 'invalid' });
  assert.deepEqual(engine.device.activeReplica.outbox, before);
  assert.deepEqual(events, [{ operation: 'exercise-create', outcome: 'saved-local' }, { operation: 'exercise-create', outcome: 'refused' }]);
  assert.deepEqual(failures, []);
});

test('an adapter pinned to a previous replica cannot write into another account', async (t) => {
  const { api, engine } = await open(t);
  t.mock.method(engine, 'commit', async (scope, read) => read({ replica: 'anotherAccount' }));
  await assert.rejects(api.createRoutine(routine), { code: 'not-writable', sentence: 'Sign in to save to your training log.' });
});

test('liveHint follows the phone session and expires after four idle hours', async (t) => {
  const { engine } = await open(t);
  const now = Date.now();
  let rows = [{ t: 'session', id: 'session0001', life: ['alive', 's'], f: { startedAt: [now - 1000, 's'] } }];
  t.mock.method(engine, 'observe', () => ({ getSnapshot: () => ({ drawn: rows }) }));
  assert.equal(gymLiveHint(engine), true);
  rows[0] = { ...rows[0], f: { startedAt: [now - 4 * 3600_000, 's'] } };
  assert.equal(gymLiveHint(engine), false);
  rows.push({ t: 'set', id: 'set0000001', f: { sessionId: ['session0001', 's'], completedAt: [now, 's'] } });
  assert.equal(gymLiveHint(engine), true);
  rows = [];
  assert.equal(gymLiveHint(engine), false, 'no open workout, no live hint');
});

test('known overlap, future instants and live corrections refuse before queuing', async (t) => {
  const { api, engine } = await open(t);
  const imported = { id: 'session00001', startedAt: 100, finishedAt: 900, sets: [{ id: 'set00000001', exerciseId: 'bench-press', weightKg: 60, reps: 5, completedAt: 850 }] };
  await api.importSession(imported);
  const before = structuredClone(engine.device.activeReplica.outbox);
  await assert.rejects(api.importSession({ ...imported, id: 'session00002', sets: [{ ...imported.sets[0], id: 'set00000002' }] }), { code: 'session-overlap' });
  await assert.rejects(api.importSession({ ...imported, id: 'session00002', finishedAt: 2000 }), { code: 'bad-instant' });
  await engine.commit('self/gym', [], { cmd: { name: 'gym.start', args: { id: 'phoneSession0', startedAt: 1000, joinOpenSession: true } },
    predict: [{ op: 'create', t: 'session', id: 'phoneSession0', f: { startedAt: 1000 } }] });
  await assert.rejects(api.correctSession('phoneSession0', { requestId: 'correction00', startedAt: 100, finishedAt: 900, routineName: '', sets: imported.sets }), { code: 'session-open' });
  assert.deepEqual(engine.device.activeReplica.entries().filter((entry) => entry.intent.cmd?.name === 'gym.importSession'), before.filter((entry) => entry.intent.cmd?.name === 'gym.importSession'));
});

test('a tombstoned set cannot be corrected as if its value were saved', async (t) => {
  const { api, engine } = await open(t);
  await api.importSession({ id: 'session00001', startedAt: 100, finishedAt: 900, sets: [{ id: 'set00000001', exerciseId: 'bench-press', weightKg: 60, reps: 5, completedAt: 850 }] });
  await api.holdDeath('set', 'set00000001');
  const before = structuredClone(engine.device.activeReplica.outbox);
  await assert.rejects(api.fixSet('session00001', 'set00000001', { reps: 6 }), { code: 'unknown-record' });
  assert.deepEqual(engine.device.activeReplica.outbox, before);
});

test('domain preferences save only client fields, keep untouched registers, and report unchanged and refused outcomes', async (t) => {
  const { api, engine, events, failures } = await open(t);
  await api.savePreferences({ units: 'lb', confirmHaptic: false, restSeconds: 180, restSound: false });
  assert.deepEqual(engine.device.activeReplica.entries().map(({ intent }) => intent.d.map(({ f }) => Object.keys(f).sort())),
    [[['confirmHaptic', 'units']]]);
  assert.deepEqual(await api.preferences(), { units: 'lb', confirmHaptic: false, confirmSound: false, restSound: true });
  await api.savePreferences({ units: 'lb' });
  await assert.rejects(api.savePreferences({ units: 'stone' }), { code: 'invalid' });
  assert.deepEqual(events, [
    { operation: 'preferences-save', outcome: 'saved-local' },
    { operation: 'preferences-save', outcome: 'unchanged' },
    { operation: 'preferences-save', outcome: 'refused' },
  ]);
  assert.deepEqual(failures, []);
});

test('domain weigh-in refusals write nothing and emit no Sentry failures', async (t) => {
  const { api, engine, events, failures } = await open(t);
  for (const [day, weightKg] of [['1970-01-02', 80], ['1970-02-30', 80], ['1970-01-01', 19]]) {
    await assert.rejects(api.saveBodyweight(day, { weightKg }), { code: 'invalid' });
  }
  assert.equal(await api.deleteBodyweight('1970-01-01'), null);
  assert.deepEqual(engine.device.activeReplica.outbox, []);
  assert.deepEqual(events, [
    ...Array.from({ length: 3 }, () => ({ operation: 'bodyweight-save', outcome: 'refused' })),
    { operation: 'delete', outcome: 'unchanged' },
  ]);
  assert.deepEqual(failures, []);
});

for (const [operation, write] of [
  ['bodyweight-save', (api) => api.saveBodyweight('1970-01-01', { weightKg: 80 })],
  ['preferences-save', (api) => api.savePreferences({ units: 'lb' })],
  ['delete', (api) => api.deleteBodyweight('1970-01-01')],
  ['note-save', (api) => api.saveNote('note000001', { title: 'Kept', body: '' })],
  ['note-reorder', (api) => api.moveNote('note000001', null)],
  ['delete', (api) => api.deleteNote('note000001')],
]) {
  test(`${operation}: a failed store keeps all data and is reported only at the storage boundary`, async (t) => {
    const { api, engine, env, failures, events } = await open(t);
    await api.saveBodyweight('1970-01-01', { weightKg: 82 });
    const before = structuredClone(engine.device.activeReplica.toJSON());
    events.length = 0;
    t.mock.method(engine.store, 'transact', async () => { throw new Error('SECRET record values'); });
    await assert.rejects(write(api), isStoreFailure);
    assert.deepEqual(engine.device.activeReplica.toJSON(), before);
    assert.deepEqual(failures, []);
    assert.deepEqual(env.failures, ['storage']);
    assert.deepEqual(events, [{ operation, outcome: 'failed' }]);
  });
  test(`${operation}: unexpected boundary errors report only the static operation`, async (t) => {
    const { api, engine, failures, events } = await open(t);
    t.mock.method(engine, 'commit', async () => { throw new Error('SECRET record values'); });
    await assert.rejects(write(api));
    assert.deepEqual(failures, [operation]);
    assert.deepEqual(events, [{ operation, outcome: 'failed' }]);
  });
  test(`${operation}: an old account adapter refuses writes after a replica switch`, async (t) => {
    const { api, engine, failures, events } = await open(t);
    const commit = engine.commit.bind(engine);
    t.mock.method(engine, 'commit', (scope, build) => commit(scope, (views) => build({ ...views, replica: 'another-account' })));
    await assert.rejects(write(api), { code: 'not-writable' });
    assert.deepEqual(engine.device.activeReplica.outbox, []);
    assert.deepEqual(failures, []);
    assert.deepEqual(events, [{ operation, outcome: 'refused' }]);
  });
}


test('rapid preference changes compare against the previous commit and keep the last choice', async (t) => {
  const { api, events, failures } = await open(t);
  await Promise.all([api.savePreferences({ units: 'lb' }), api.savePreferences({ units: 'kg' })]);
  assert.deepEqual(await api.preferences(), { units: 'kg', confirmHaptic: true, confirmSound: false, restSound: true });
  assert.deepEqual(events, [
    { operation: 'preferences-save', outcome: 'saved-local' },
    { operation: 'preferences-save', outcome: 'saved-local' },
  ]);
  assert.deepEqual(failures, []);
});

test('domain read handles cannot follow the engine into another account', async (t) => {
  const { api, engine, failures } = await open(t);
  t.mock.method(engine, 'activeReplica', () => 'another-account');
  await assert.rejects(api.preferences(), { code: 'not-writable' });
  await assert.rejects(api.bodyweight(), { code: 'not-writable' });
  await assert.rejects(api.notes(), { code: 'not-writable' });
  assert.throws(() => api.mintNote(), { code: 'not-writable' });
  assert.deepEqual(failures, []);
});
