import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Reader, Views } from '../../../src/platform/domain-kit/reading.js';
import { FixedZone, Instant, Moment } from '../../../src/platform/domain-kit/time.js';
import { registry } from '../../../src/platform/sync/schema.js';
import { syncSession } from '../../../src/platform/sync/session.js';
import { Session } from '../../../src/products/gym/domain/training.js';
import { TrainingHistory } from '../../../src/products/gym/domain/trainingHistory.js';
import { useTrainingLog } from '../../../src/products/gym/useTrainingLog.js';
import { browserWith, renderHook } from './harness.mjs';

const stamp = '1000:0:r_aaaaaaaaaaaa';
const row = (t, id, fields) => ({ t, id, born: stamp, life: ['alive', stamp], f: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, [value, stamp]])) });
function log(t, rows = []) {
  browserWith();
  let records = { replica: 'bound', drawn: rows, stored: rows, notices: [], undoOffers: [], firstPullComplete: true };
  const observation = { subscribe: () => () => {}, getSnapshot: () => records };
  const engine = { registry, now: () => Date.now(), device: { activeReplica: { meta: { serverOffsetMs: 0 } } },
    readMetadata: () => ({ firstPullComplete: records.firstPullComplete }), activeReplica: () => 'bound', observe: () => observation,
    getSnapshot: () => ({ state: 'bound' }), observeEngine: () => () => {} };
  const session = { ready: true, signedIn: true, engine };
  t.mock.method(syncSession, 'getSnapshot', () => session);
  const view = renderHook(t, () => useTrainingLog());
  return { view, update: (change) => { records = { ...records, ...change }; view.redraw(); }, engine };
}

for (const workouts of [250, 1000]) test(`training reads recompute once per replica change for ${workouts} populated workouts`, (t) => {
  const now = Date.UTC(2026, 9, 8, 12);
  t.mock.timers.enable({ apis: ['Date'], now });
  const sessionsRead = t.mock.method(TrainingHistory.prototype, 'sessions');
  const exercisesRead = t.mock.method(TrainingHistory.prototype, 'exercises');
  const recomputations = () => ({ sessions: sessionsRead.mock.callCount(), exercises: exercisesRead.mock.callCount() });
  const rows = [];
  for (let index = 0; index < workouts; index += 1) {
    const id = `session_${String(index).padStart(5, '0')}`;
    const at = now - (workouts - index) * 86400000;
    rows.push(row('session', id, { startedAt: at, finishedAt: at + 3600000, closedBy: 'finish' }));
    for (let set = 0; set < 20; set += 1) rows.push({
      ...row('set', `${id}_set_${set}`, { sessionId: id,
        exerciseId: ['bench-press', 'back-squat', 'deadlift', 'pull-up'][Math.floor(set / 5)],
        weightKg: 60 + index % 20, reps: 8, kind: 'working', completedAt: at + 60000 * (set + 1) }),
      v: { setNumber: set % 5 + 1 },
    });
  }
  const { view, update } = log(t, rows);
  assert.deepEqual(recomputations(), { sessions: 1, exercises: 1 }, 'mount computes each training read once');
  assert.equal(view.log.summaries.length, 50);
  assert.equal(view.log.progress.data.sessions.length, workouts);
  const summaries = view.log.summaries;
  const progress = view.log.progress.data;
  view.redraw();
  assert.deepEqual(recomputations(), { sessions: 1, exercises: 1 }, 'unchanged replica does no domain recomputation');
  assert.equal(view.log.summaries, summaries, 'unchanged replica reuses the training read');
  assert.equal(view.log.progress.data, progress, 'unchanged replica reuses progress facts');
  const changed = [...rows,
    row('session', 'session_new', { startedAt: now - 1000, finishedAt: now, closedBy: 'finish' }),
    row('set', 'session_new_set', { sessionId: 'session_new', exerciseId: 'bench-press',
      weightKg: 80, reps: 8, kind: 'working', completedAt: now }),
  ];
  update({ drawn: changed, stored: changed });
  assert.deepEqual(recomputations(), { sessions: 2, exercises: 2 }, 'changed replica recomputes each training read once');
  assert.equal(view.log.summaries[0].id, 'session_new');
  assert.equal(view.log.progress.data.sessions.length, workouts + 1);
  assert.notEqual(view.log.summaries, summaries);
  assert.notEqual(view.log.progress.data, progress);
  const changedSummaries = view.log.summaries;
  const changedProgress = view.log.progress.data;
  view.redraw();
  assert.deepEqual(recomputations(), { sessions: 2, exercises: 2 }, 'changed replica is cached for the next render');
  assert.equal(view.log.summaries, changedSummaries);
  assert.equal(view.log.progress.data, changedProgress);
});

const moment = new Moment(new Instant(1_800_000_000_000), new FixedZone(0));

for (const workouts of [250, 1000]) test(`stored history finds no presence for an untrained movement across ${workouts} workouts, and reports its cost`, (t) => {
  /** @param {string} type @param {string} id @param {Record<string, import('../../../src/platform/domain-kit/values.js').Json>} fields */
  const row = (type, id, fields) => ({ t: type, id, born: '1000:0:srv', life: /** @type {[string, string]} */ (['alive', '1000:0:srv']),
    f: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, /** @type {[import('../../../src/platform/domain-kit/values.js').Json, string]} */ ([value, '1000:0:srv'])])) });
  const rows = [];
  for (let index = 0; index < workouts; index += 1) {
    const id = `session_${index}`;
    const at = moment.now.ms - (workouts - index) * 86400000;
    rows.push(row('session', id, { startedAt: at, finishedAt: at + 3600000 }));
    for (let set = 0; set < 20; set += 1) rows.push(row('set', `${id}_set_${set}`,
      { sessionId: id, exerciseId: 'bench-press', weightKg: 60, reps: 8, completedAt: at + set + 1 }));
  }
  const history = new TrainingHistory(new Reader(Views.ofRecords(registry, { drawn: rows, stored: rows }), Session.scope, moment));
  const cpu = process.cpuUsage();
  const wall = performance.now();
  const found = history.hasStoredSessions({ exercise: 'chin-up' });
  const elapsed = process.cpuUsage(cpu);
  const milliseconds = (elapsed.user + elapsed.system) / 1000;
  t.diagnostic(`${workouts} workouts: stored absence ${milliseconds.toFixed(1)} ms CPU, ${(performance.now() - wall).toFixed(1)} ms wall`);
  assert.equal(found, false);
  assert.ok(milliseconds < (workouts === 250 ? 100 : 300), `stored absence ${milliseconds.toFixed(1)} ms CPU exceeds budget`);
});
