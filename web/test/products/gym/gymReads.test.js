import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gymReadView, namedZone, createGymApi, exerciseDocument } from '../../../src/products/gym/gymRuntime.js';
import { gymAccount } from './harness.mjs';

const readView = (rows, { now = Date.now(), timeZone = 'UTC' } = {}) => gymReadView({ drawn: rows, stored: rows }, { now, zone: namedZone(timeZone) });
import { SeedExercises } from '../../../src/products/gym/domain/seedExercises.js';

const at = Date.UTC(2026, 8, 21, 18);
const row = (t, id, fields, extra = {}) => ({ t, id, ...(t === 'prefs' || t === 'exerciseName' ? {} : { life: ['alive', '1000:0:srv'], born: '1000:0:srv' }), f: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, [value, '1000:0:srv']])), rc: at, ru: at, ...extra });
const sessionRow = (id, start, fields = {}) => row('session', id, { startedAt: start, finishedAt: start + 60 * 60 * 1000, closedBy: 'finish', ...fields });
const setRow = (id, sessionId, fields = {}) => row('set', id, { sessionId, exerciseId: 'bench-press', weightKg: 60, reps: 8, kind: 'working', note: '', completedAt: at + 1000, ...fields }, { v: { setNumber: 1 } });
const seedsInDomain = SeedExercises.all.map(exerciseDocument);
const seed = seedsInDomain.find((exercise) => exercise.id === 'bench-press');

test('global catalog mirrors every schema seed, overrides seed names, and omits empty aliases', () => {
  const schema = readFileSync(new URL('../../../../backend/db/schema.sql', import.meta.url), 'utf8');
  const source = schema.split('insert into gym_exercises (id, name, pattern, equipment, step_kg) values\n')[1].split('on conflict (id) do nothing;')[0];
  const seeds = [...source.matchAll(/\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*([\d.]+)\)/g)].map(([, id, name, pattern, equipment, step]) => ({ id, name, pattern, equipment, stepKg: Number(step), custom: false }));
  assert.deepEqual(seedsInDomain, seeds);
  const rows = [row('exerciseName', 'bench-press', { name: 'Flat Press', aliases: ['Bench Press'] }), row('exerciseName', 'deadlift', { aliases: [] }), row('exercise', 'custom_mv', { name: 'My Press', equipment: 'machine', pattern: 'press', stepKg: 5, aliases: [] })];
  const api = readView(rows);
  assert.deepEqual(api.exercises().filter((exercise) => ['bench-press', 'custom_mv'].includes(exercise.id)), [{ ...seed, name: 'Flat Press', aliases: ['Bench Press'] }, { id: 'custom_mv', name: 'My Press', pattern: 'press', equipment: 'machine', stepKg: 5, custom: true }]);
  assert.deepEqual(readView([row('exerciseName', 'bench-press', { aliases: ['Flat Press'] })]).exercises().filter((exercise) => exercise.id === 'bench-press'), [{ ...seed, aliases: ['Flat Press'] }]);
});

test('session details keep frozen plan, corrected display name, serial numbers and genuine absences', () => {
  const rows = [sessionRow('session_a', at, { plan: { routine: 'Push A', entries: [{ exerciseId: 'bench-press', sets: [{}, { reps: 8 }, { weightKg: 0 }], restSeconds: 90 }] }, displayName: '', routineId: null }), setRow('working_1', 'session_a', { rpe: null }), setRow('warmup_1', 'session_a', { completedAt: at - 10, kind: 'warmup', rpe: 6 }, { v: { setNumber: 2 } })];
  rows[2].v = { setNumber: 2 };
  assert.deepEqual(readView(rows).session('session_a'), { session: { id: 'session_a', startedAt: at, finishedAt: at + 3600000, routineName: '', plan: { routine: 'Push A', entries: [{ exerciseId: 'bench-press', sets: [{}, { reps: 8 }, { weightKg: 0 }], restSeconds: 90 }] } }, sets: [ { id: 'warmup_1', exerciseId: 'bench-press', setNumber: 2, weightKg: 60, reps: 8, kind: 'warmup', rpe: 6, note: '', completedAt: at - 10 }, { id: 'working_1', exerciseId: 'bench-press', setNumber: 1, weightKg: 60, reps: 8, kind: 'working', note: '', completedAt: at + 1000 } ] });
  assert.equal(readView(rows).session('missing'), null);
});

test('malformed frozen plans report a static failure while unrelated reads stay available', async (t) => {
  const plan = { routine: 'Broken', entries: [{ exerciseId: 123 }] };
  const rows = [sessionRow('session_a', at, { plan }), setRow('working_1', 'session_a'),
    row('note', 'note_aaa', { title: 'Kept', body: 'Private', ord: 'a0' })];
  const before = structuredClone(rows);
  const gym = await gymAccount(t, rows);
  const failures = [];
  const api = createGymApi(gym.engine, { failure: (...args) => failures.push(args), event: () => {} });
  assert.deepEqual(await api.session('session_a'), { session: { id: 'session_a', startedAt: at, finishedAt: at + 3600000 },
    sets: [{ id: 'working_1', exerciseId: 'bench-press', setNumber: 1, weightKg: 60, reps: 8, kind: 'working', note: '', completedAt: at + 1000 }] });
  assert.deepEqual(await api.notes(), [{ id: 'note_aaa', position: 0, title: 'Kept', body: 'Private' }]);
  assert.deepEqual(failures, [['projection']]);
  assert.deepEqual(rows, before, 'reading leaves the stored plan intact');
});

test('frozen plan reads preserve values outside editor bounds', () => {
  const plan = { routine: 'Push', entries: [{ exerciseId: 'bench-press', sets: [{ reps: 0, weightKg: 0 }], restSeconds: 1 }, { exerciseId: 'deadlift', sets: [] }] };
  assert.deepEqual(readView([sessionRow('session_a', at, { plan })]).session('session_a').session.plan, plan);
});

test('summaries count only working facts, clamp assisted volume, and keyset page equal starts', () => {
  const rows = [sessionRow('session_b', at), sessionRow('session_a', at), setRow('working_1', 'session_a', { weightKg: -10, reps: 8 }), setRow('working_2', 'session_a', { weightKg: 50, reps: 10 }), setRow('warmup_1', 'session_a', { kind: 'warmup', weightKg: 150 }), setRow('drop_set1', 'session_a', { kind: 'drop', weightKg: 70 })];
  const api = readView(rows);
  assert.deepEqual(api.sessions({ limit: 1 }), [{ id: 'session_a', startedAt: at, finishedAt: at + 3600000, setCount: 4, workingSetCount: 2, tonnageKg: 500, exercises: ['Bench Press'], topSet: { weightKg: 50, reps: 10 }, topE1rm: 50 * (1 + 10 / 30), record: false, closedItself: false }]);
  assert.deepEqual(api.sessions({ before: at, beforeId: 'session_a' }), [{ id: 'session_b', startedAt: at, finishedAt: at + 3600000, setCount: 0, workingSetCount: 0, tonnageKg: 0, exercises: [], record: false, closedItself: false }]);
});

test('volume totals retain PostgreSQL decimal precision across a complete log', () => {
  const rows = [sessionRow('session_a', at), setRow('working_1', 'session_a', { weightKg: 77.3, reps: 17 }), setRow('working_2', 'session_a', { weightKg: 66.77, reps: 15 })];
  const api = readView(rows);
  assert.equal(api.sessions()[0].tonnageKg, 2315.65);
  assert.equal(api.history().summary.tonnageKg, 2315.65);
  assert.equal(api.history().sessions[0].tonnageKg, 2315.65);
  assert.deepEqual(api.history().sessions[0].movements, [{ exerciseId: 'bench-press', sets: 2, reps: 32, tonnageKg: 2315.65 }]);
});

test('review needs four working sets and compares to earlier finished routines', () => {
  const previous = at - 7 * 86400000;
  const rows = [sessionRow('previous', previous, { routineId: 'routine_a', plan: { routine: 'Push A', entries: [] } }), sessionRow('current_s', at, { routineId: 'routine_a', plan: { routine: 'Push A', entries: [{ exerciseId: 'bench-press', sets: [{ reps: 8 }] }] } }), setRow('prior_set', 'previous', { weightKg: 60, reps: 8, completedAt: previous + 1000 }), ...Array.from({ length: 4 }, (_, index) => setRow(`current_${index}`, 'current_s', { weightKg: 65, reps: 8, completedAt: at + index * 1000 }))];
  assert.deepEqual(readView(rows).review('current_s'), { stats: { durationMs: 3600000, workingSets: 4, topE1rm: 65 * (1 + 8 / 30) }, slight: false, record: { kind: 'e1rm', exerciseId: 'bench-press', value: 65 * (1 + 8 / 30), weightKg: 65, reps: 8, previous: 76, previousAt: previous }, against: { sessionId: 'previous', routine: 'Push A', startedAt: previous, movements: [{ exerciseId: 'bench-press', now: { weightKg: 65, reps: 8, sets: 4 }, before: { weightKg: 60, reps: 8, sets: 1 }, planned: { sets: [{ reps: 8 }] } }] } });
  assert.deepEqual(readView(rows.slice(0, -1)).review('current_s'), { stats: { durationMs: 3600000, workingSets: 3, topE1rm: 65 * (1 + 8 / 30) }, slight: true });
  assert.equal(readView(rows).sessions({ limit: 1 })[0].record, true);
});

test('last-time and lastSets exclude warmups and open sessions, retaining drop and failure facts', () => {
  const rows = [sessionRow('previous', at), row('session', 'open_now', { startedAt: at + 86400000 }), setRow('working_1', 'previous', { weightKg: 100 }), setRow('last_set1', 'previous', { weightKg: 40, reps: 12, kind: 'drop' }), setRow('warmup_1', 'previous', { weightKg: 120, kind: 'warmup' }), setRow('open_set1', 'open_now', { weightKg: 200, completedAt: at + 86400001 })];
  rows[3].v.setNumber = 3; rows[4].v.setNumber = 4;
  const api = readView(rows, { now: at + 86400002 });
  assert.deepEqual(api.lastSets(), [{ exerciseId: 'bench-press', weightKg: 40, reps: 12, at }]);
  assert.deepEqual(api.lastTime('bench-press'), { exerciseId: 'bench-press', session: { id: 'previous', startedAt: at, finishedAt: at + 3600000 }, sets: ['working_1', 'last_set1'].map((id) => api.session('previous').sets.find((set) => set.id === id)) });
  assert.deepEqual(api.lastTime('back-squat'), { exerciseId: 'back-squat' });
});

test('progress qualifies estimates, preserves signed facts and uses stable tie rules', () => {
  const rows = [sessionRow('session_a', at), row('session', 'session_o', { startedAt: at + 86400000 }), setRow('set_zzzz', 'session_a', { weightKg: 60, reps: 1 }), setRow('set_aaaa', 'session_a', { weightKg: 60, reps: 1, rpe: 7 }), setRow('set_zero', 'session_a', { weightKg: 0, reps: 8 }), setRow('set_lowr', 'session_a', { weightKg: 100, reps: 5, rpe: 6.9 }), setRow('set_many', 'session_a', { weightKg: 90, reps: 11 }), setRow('set_open', 'session_o', { weightKg: 1000 })];
  assert.deepEqual(readView(rows, { now: at + 9000 }).progress(), { asOf: at + 9000, sessions: [{ sessionId: 'session_a', startedAt: at, movements: [{ exerciseId: 'bench-press', workingSetCount: 5, heaviest: { setId: 'set_lowr', weightKg: 100, reps: 5, rpe: 6.9 }, estimate: { setId: 'set_aaaa', weightKg: 60, reps: 1, rpe: 7, e1rm: 60 } }] }] });
});

test('history applies half-open dates and identity filters before aggregate facets and pagination', () => {
  const endMonth = Date.UTC(2026, 8, 30, 23, 30);
  const rows = [sessionRow('session_a', endMonth, { historyRoutineId: 'routine_a', plan: { routine: 'Old name', entries: [] } }), sessionRow('session_b', endMonth + 86400000, { historyRoutineId: 'routine_a', displayName: 'New name' }), setRow('working_1', 'session_a', { completedAt: endMonth + 1000, weightKg: 60, reps: 8 }), setRow('warmup_1', 'session_b', { completedAt: endMonth + 86401000, kind: 'warmup', weightKg: 80 })];
  const api = readView(rows, { now: endMonth, timeZone: 'Europe/Belgrade' });
  const history = api.history({ exercise: 'bench-press', routine: 'routine_a', limit: 1, projection: 'progress' });
  assert.deepEqual({ summary: history.summary, months: history.months, exercises: history.exercises, routines: history.routines, next: history.next }, { summary: { sessions: 2, sets: 1, reps: 8, tonnageKg: 480 }, months: [{ month: '2026-10', sessions: 2 }], exercises: [{ id: 'bench-press', name: 'Bench Press', sessions: 2, equipment: 'barbell' }], routines: [{ id: 'routine_a', name: 'New name', sessions: 2 }], next: { before: endMonth + 86400000, beforeId: 'session_b' } });
  assert.deepEqual(history.sessions[0], { id: 'session_b', startedAt: endMonth + 86400000, finishedAt: endMonth + 90000000, routineId: 'routine_a', routineName: 'New name', setCount: 1, workingSetCount: 0, reps: 0, tonnageKg: 0, sets: [{ id: 'warmup_1', exerciseId: 'bench-press', exercise: 'Bench Press', setNumber: 1, weightKg: 80, reps: 8, completedAt: endMonth + 86401000 }], movements: [{ exerciseId: 'bench-press', sets: 0, reps: 0, tonnageKg: 0 }], exerciseNames: ['Bench Press'] });
  assert.deepEqual(api.history({ ...history.next, limit: 1 }).sessions.map((entry) => entry.id), ['session_a']);
  assert.deepEqual(api.history({ from: endMonth, until: endMonth + 86400000 }).sessions.map((entry) => entry.id), ['session_a']);
  assert.deepEqual(history.progress.sessions.map((entry) => entry.sessionId), ['session_a']);
});

test('preferences defaults, weigh-in range latest and fractional note order survive cache snapshots', () => {
  assert.deepEqual(readView([]).preferences(), { units: 'kg', restSound: true, confirmHaptic: true, confirmSound: false });
  const rows = [row('prefs', 'prefs', { units: 'lb', restSeconds: null, restSound: false }), row('weighin', '2026-09-20', { kg: 70.25, recordedAt: at }), row('weighin', '2026-09-21', { kg: 70.5, recordedAt: at + 1 }), row('note', 'note_bbb', { title: 'B', body: 'second', ord: 'a1' }), row('note', 'note_aaa', { title: 'A', body: 'first', ord: 'a0' })];
  const api = readView(JSON.parse(JSON.stringify(rows)));
  assert.deepEqual(api.preferences(), { units: 'lb', restSound: false, confirmHaptic: true, confirmSound: false });
  assert.deepEqual(api.bodyweight({ to: '2026-09-20' }), { entries: [{ dateLocal: '2026-09-20', weightKg: 70.25, recordedAt: at }], latest: { dateLocal: '2026-09-21', weightKg: 70.5, recordedAt: at + 1 } });
  assert.deepEqual(api.notes(), [{ id: 'note_aaa', position: 0, title: 'A', body: 'first' }, { id: 'note_bbb', position: 1, title: 'B', body: 'second' }]);
});

test('routine schemes and proposal removed counts project without inventing absent server metadata', () => {
  const rows = [row('routine', 'routine_a', { name: 'Push', position: 2, createdDoor: 'ask', entries: [{ exerciseId: 'bench-press', sets: [{}, { reps: 8 }, { weightKg: 0 }], restSeconds: 90 }] }), sessionRow('session_a', at, { routineId: 'routine_a' }), row('proposal', 'proposal_a', { routineId: 'routine_a', intent: 'revise', proposedName: 'Push B', summary: 'A change', door: 'mcp', connection: 'connection1', agent: 'My coach', state: 'pending', changes: [{ kind: 'removed', exerciseId: 'bench-press', before: { sets: [{ reps: 8 }] } }] }), setRow('working_1', 'session_a'), setRow('warmup_1', 'session_a', { kind: 'warmup' })];
  const api = readView(rows);
  const head = { id: 'proposal_a', routineId: 'routine_a', intent: 'revise', state: 'pending', summary: 'A change', createdAt: at, source: { door: 'mcp', connection: 'connection1', agent: 'My coach' } };
  assert.deepEqual(api.routine('routine_a'), { id: 'routine_a', name: 'Push', position: 2, entries: [{ position: 1, exerciseId: 'bench-press', sets: [{}, { reps: 8 }, { weightKg: 0 }], restSeconds: 90 }], lastTrainedAt: at, pendingProposal: head, history: [{ kind: 'proposal', at, proposal: head }, { kind: 'created', at, by: 'ask' }] });
  assert.deepEqual(api.proposal('proposal_a'), { ...head, name: 'Push B', changes: [{ position: 1, kind: 'removed', exerciseId: 'bench-press', before: { sets: [{ reps: 8 }] }, loggedSets: 2 }] });
  assert.equal('revision' in api.routines()[0], false);
  assert.equal('movements' in api.routine('routine_a').history.at(-1), false);
  assert.equal('baseName' in api.proposal('proposal_a'), false);
  assert.equal('baseRevision' in api.proposal('proposal_a'), false);
  assert.equal('changeCount' in api.proposal('proposal_a'), false);
  assert.equal('updatedAt' in readView([row('note', 'note_aaa', { title: 'A', body: '', ord: 'a0' })]).notes()[0], false);
});

test('terminal deaths and orphan sets cannot reappear in any projection', () => {
  const rows = [sessionRow('session_a', at), setRow('working_1', 'session_a'), setRow('orphan_1', 'missing_s'), row('note', 'note_aaa', { title: 'A', body: '', ord: 'a0' }), row('weighin', '2026-09-21', { kg: 70.5, recordedAt: at })];
  for (const entry of rows.filter((entry) => entry.t !== 'set')) entry.life = ['dead', '2000:0:srv'];
  const api = readView(rows);
  assert.deepEqual(api.sessions(), []);
  assert.equal(api.session('session_a'), null);
  assert.equal(api.review('session_a'), null);
  assert.deepEqual(api.progress(), { asOf: api.progress().asOf, sessions: [] });
  assert.deepEqual(api.notes(), []);
  assert.deepEqual(api.bodyweight(), { entries: [], latest: null });
  assert.deepEqual(api.lastSets(), []);
  assert.deepEqual(api.history().summary, { sessions: 0, sets: 0, reps: 0, tonnageKg: 0 });
});

test('proposal domain reads retain typed targets and confirmed chronology while excluding hidden training', () => {
  const proposal = row('proposal', 'proposal_a', { routineId: 'routine_a', intent: 'revise', proposedName: 'Push B',
    summary: 'A change', changes: [
      { kind: 'kept', exerciseId: 'pull-up', before: { sets: [{ reps: null, weightKg: null }] }, after: {} },
      { kind: 'removed', exerciseId: 'bench-press', before: {} },
    ] });
  const stored = [proposal, sessionRow('session_a', at), sessionRow('session_b', at - 86400000),
    setRow('visible_set', 'session_a'), setRow('hidden_set', 'session_a'), setRow('hidden_session_set', 'session_b'),
    setRow('orphan_set', 'missing_session')];
  const withoutEnvelopeTime = ({ rc, ...record }) => record;
  const drawn = stored.filter((record) => !['session_b', 'hidden_set'].includes(record.id)).map(withoutEnvelopeTime);
  const api = gymReadView({ drawn, stored: stored.map(withoutEnvelopeTime), confirmed: stored }, { now: at });
  const head = { id: 'proposal_a', routineId: 'routine_a', intent: 'revise', state: 'pending', summary: 'A change',
    source: { door: 'ask' }, createdAt: at };
  assert.deepEqual(api.proposals(), [head]);
  assert.deepEqual(api.proposal('proposal_a'), { ...head, name: 'Push B', changes: [
    { position: 1, kind: 'kept', exerciseId: 'pull-up', before: { sets: [{}] }, after: {} },
    { position: 2, kind: 'removed', exerciseId: 'bench-press', before: {}, loggedSets: 1 },
  ] });
});

test('server registers supply frozen metadata and zero-based notes without treating reorder receipts as content times', () => {
  const rows = [
    row('routine', 'routine_a', { name: 'Push', entries: [{ exerciseId: 'bench-press' }], revision: 7, createdEntries: 3 }),
    row('proposal', 'proposal_a', { routineId: 'routine_a', intent: 'revise', proposedName: 'Push B', summary: 'Change', door: 'ask', changes: [], baseRevision: 6, baseName: 'Push A', changeCount: 2 }),
    row('note', 'note_aaa', { title: 'A', body: '', ord: 'a2', updatedAt: at - 1000 }, { ru: at + 1000 }),
    row('note', 'note_bbb', { title: 'B', body: '', ord: 'a1' }, { ru: at + 2000 }),
  ];
  const api = readView(rows);
  assert.equal(api.routine('routine_a').revision, 7);
  assert.deepEqual(api.routine('routine_a').history.at(-1), { kind: 'created', at, movements: 3 });
  assert.deepEqual(api.proposal('proposal_a'), { id: 'proposal_a', routineId: 'routine_a', intent: 'revise', state: 'pending', summary: 'Change', createdAt: at, source: { door: 'ask' }, changeCount: 2, name: 'Push B', changes: [], baseRevision: 6, baseName: 'Push A' });
  assert.deepEqual(api.notes(), [{ id: 'note_bbb', position: 0, title: 'B', body: '' }, { id: 'note_aaa', position: 1, title: 'A', body: '', updatedAt: at - 1000 }]);
});

test('client stale closure uses the exact four-hour cutoff and never mutates confirmed facts', () => {
  const fourHours = 4 * 3600000;
  const rows = [row('session', 'session_a', { startedAt: at })];
  const before = readView(rows, { now: at + fourHours - 1 });
  assert.deepEqual(before.session('session_a'), { session: { id: 'session_a', startedAt: at }, sets: [] });
  assert.equal(before.liveHint(), true);
  const cutoff = readView(rows, { now: at + fourHours });
  assert.deepEqual(cutoff.session('session_a'), { session: { id: 'session_a', startedAt: at, finishedAt: at }, sets: [] });
  assert.equal(cutoff.sessions()[0].closedItself, true);
  assert.equal(cutoff.liveHint(), false);
  assert.equal('finishedAt' in rows[0].f, false);
});

test('any recent set prevents stale close, and finished sessions retain their recorded finish', () => {
  const rows = [row('session', 'open_ses', { startedAt: at - 5 * 3600000 }), setRow('recent_1', 'open_ses', { completedAt: at - 1000, kind: 'warmup' }), sessionRow('finished_s', at - 6 * 3600000)];
  const live = readView(rows, { now: at });
  assert.equal('finishedAt' in live.session('open_ses').session, false);
  assert.equal(live.liveHint(), true);
  assert.equal(live.session('finished_s').session.finishedAt, at - 5 * 3600000);
  const stale = readView(rows, { now: at + 4 * 3600000 - 1000 });
  assert.equal(stale.session('open_ses').session.finishedAt, at - 1000);
  assert.equal(stale.sessions().find((session) => session.id === 'open_ses').closedItself, true);
  assert.equal(stale.liveHint(), false);
});

test('record ladder, recent nonwarmup rows, and stats use lifetime finished working history', () => {
  const old = at - 14 * 7 * 86400000;
  const rows = [sessionRow('session_a', old), sessionRow('session_b', at), setRow('old_set1', 'session_a', { weightKg: 50, reps: 8, completedAt: old + 1000 }), setRow('new_set1', 'session_b', { weightKg: 60, reps: 8 }), setRow('drop_set1', 'session_b', { weightKg: 70, kind: 'drop' }), setRow('warmup_1', 'session_b', { weightKg: 100, kind: 'warmup' })];
  const api = readView(rows, { now: at });
  assert.deepEqual(api.record('bench-press'), { exercise: seed, routineCount: 0, sessionCount: 2, bestE1rm: { weightKg: 60, reps: 8, at, e1rm: 76 }, heaviest: { weightKg: 60, reps: 8, at, e1rm: 76 }, e1rmSeries: [{ at, weightKg: 60, reps: 8, e1rm: 76 }], records: [{ at, weightKg: 60, reps: 8, e1rm: 76 }, { at: old, weightKg: 50, reps: 8, e1rm: 50 * (1 + 8 / 30) }], recentDays: [{ sessionId: 'session_b', startedAt: at, sets: [api.session('session_b').sets[0], api.session('session_b').sets[1]] }, { sessionId: 'session_a', startedAt: old, sets: api.session('session_a').sets }] });
  assert.equal(api.record('absent_mv'), null);
  const stats = api.stats();
  assert.deepEqual(stats.movements, [{ exerciseId: 'bench-press', lastTrainedAt: at, points: [{ at: old, weightKg: 50, reps: 8, e1rm: 50 * (1 + 8 / 30) }, { at, weightKg: 60, reps: 8, e1rm: 76 }], bestE1rm: { weightKg: 60, reps: 8, at, e1rm: 76 }, heaviest: { weightKg: 60, reps: 8, at, e1rm: 76 } }]);
  assert.equal(stats.weeks.length, 15);
  assert.deepEqual(stats.weeks[1], { startedAt: Date.UTC(2026, 5, 22), sessions: 0, workingSets: 0 });
});
