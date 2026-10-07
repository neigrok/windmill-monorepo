import { useMemo } from 'react';
import { useSyncEngine, useSyncRecords } from '../../platform/sync/react.js';
import { recordKey } from '../../platform/sync/core/rows.js';
import { CommitError } from '../../platform/sync/client/commit.js';
import { GymRefusal, isStoreFailure } from './errors.js';
import { projectGym } from './syncProjections.js';
import { createGymRuntime, gymStep, gymFailure, routineValue } from './gymRuntime.js';
export { gymStep, gymFailure } from './gymRuntime.js';

const SCOPE = 'self/gym';
const READS = ['exercises', 'sessions', 'session', 'review', 'routines', 'routine',
  'history', 'progress', 'record', 'lastTime', 'lastSets'];
const SENTENCES = {
  stale: 'This changed on another device. Read it again before saving.',
  'session-open': 'that session is still running',
  'session-overlap': 'these times cross a session already in the log',
  'bad-instant': 'These times run past now or outside the workout.',
  'not-writable': 'Sign in to save to your training log.',
};

const refusal = (code, { sentence = SENTENCES[code], overlapping = null } = {}) => new GymRefusal(code, { sentence, overlapping });

export function createGymApi(engine, { event = gymStep, failure = gymFailure } = {}) {
  // Engine §7.1: an unwritable replica is a refusal, and a store failure is the device's, which the engine reports.
  const failed = (operation, thrown) => {
    const error = thrown instanceof CommitError && thrown.kind === 'not-writable' ? refusal('not-writable') : thrown;
    event(operation, 'failed');
    if (!(error instanceof GymRefusal) && !isStoreFailure(error)) failure(operation);
    return error;
  };
  const replica = engine.activeReplica();
  const snapshot = () => engine.observe(SCOPE).getSnapshot();
  const project = (rows = snapshot().stored, now = Date.now()) => projectGym(rows, {
    now, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, failure,
  });
  const commit = async (operation, build) => {
    try {
      const result = await engine.commit(SCOPE, (views) => {
        if (views.replica !== replica) throw refusal('not-writable');
        return build(views);
      });
      if (result.outcome?.refused) throw refusal(result.outcome.refused);
      event(operation, result.outcome ? 'saved-local' : 'unchanged');
      return result.value;
    } catch (error) { throw failed(operation, error); }
  };
  const api = createGymRuntime(engine, { event, failure });
  for (const name of READS) api[name] = async (...args) => {
    try { return project()[name](...args); }
    catch (error) { failure('projection'); throw error; }
  };
  api.fixSet = (sessionId, id, fix) => commit('set-correct', (views) => {
    const row = views.drawn.get(recordKey('set', id));
    if (!row || row.life?.[0] === 'dead' || row.f?.sessionId?.[0] !== sessionId) throw refusal('unknown-record');
    const old = project([...views.drawn.values()], views.now).session(sessionId)?.sets.find((set) => set.id === id);
    return { gesture: { changes: [{ op: 'update', t: 'set', id, f: fix }] }, value: { ...old, ...fix } };
  });
  api.holdDeath = async (t, id) => {
    if (t === 'weighin') return api.deleteBodyweight(id);
    if (t === 'note') return api.deleteNote(id);
    if (t === 'routine') return api.deleteRoutine(id);
    try {
      const answer = await engine.commit(SCOPE, (views) => {
        if (views.replica !== replica) throw refusal('not-writable');
        return { gesture: { changes: [{ op: 'delete', t, id }], opts: { hold: true } }, value: null };
      });
      const result = answer.outcome;
      if (result?.refused) throw refusal(result.refused);
      event('delete', 'held');
      return result.localIds[0]?.slice(0, result.localIds[0].lastIndexOf('/'));
    } catch (error) { throw failed('delete', error); }
  };
  api.undoDeath = async (gestureId) => {
    try { const result = await engine.undo(gestureId); event('delete', result ? 'undone' : 'closed'); return result; }
    catch (error) { throw failed('undo', error); }
  };
  const command = (operation, name, args, predict, value) => commit(operation, (views) => ({
    gesture: { changes: [], opts: { cmd: { name, args }, predict: predict(views) } }, value: value(views),
  }));
  const checkWorkout = (views, args, sessionId = null) => {
    if (![args.startedAt, args.finishedAt].every(Number.isSafeInteger) || args.startedAt <= 0 || args.finishedAt < args.startedAt || args.finishedAt > views.now || args.sets.some((set) => !Number.isSafeInteger(set.completedAt) || set.completedAt < args.startedAt || set.completedAt > args.finishedAt)) throw refusal('bad-instant');
    if (args.sets.length > 200 || (sessionId && args.sets.length === 0) || new Set(args.sets.map((set) => set.id)).size !== args.sets.length) throw refusal('invalid');
    for (const row of views.drawn.values()) {
      if (row.t !== 'session' || row.life?.[0] === 'dead' || row.id === sessionId || row.id === args.id) continue;
      const start = row.f.startedAt[0];
      const end = Math.max(row.f.finishedAt?.[0] ?? views.now, start + 1);
      if (args.startedAt < end && start < Math.max(args.finishedAt, args.startedAt + 1)) {
        throw refusal('session-overlap', { overlapping: project([...views.drawn.values()], views.now).session(row.id).session });
      }
    }
  };
  api.importSession = (args) => command('session-import', 'gym.importSession', args, (views) => {
    checkWorkout(views, args);
    const routine = project([...views.drawn.values()], views.now).routine(args.routineId);
    const numbers = new Map();
    return [{ op: 'create', t: 'session', id: args.id, f: { startedAt: args.startedAt, finishedAt: args.finishedAt,
      closedBy: 'finish', routineId: routine?.id ?? null, historyRoutineId: routine?.id ?? null,
      plan: routine ? { routine: routine.name, entries: routineValue(routine).fields().entries } : null } },
    ...args.sets.map(({ id, ...set }) => {
      const setNumber = (numbers.get(set.exerciseId) ?? 0) + 1;
      numbers.set(set.exerciseId, setNumber);
      return { op: 'create', t: 'set', id, v: { setNumber },
        f: { sessionId: args.id, kind: 'working', rpe: null, note: '', ...set } };
    })];
  }, () => ({ session: { id: args.id, startedAt: args.startedAt, finishedAt: args.finishedAt }, sets: args.sets }));
  api.correctSession = (sessionId, correction) => {
    const args = { sessionId, ...correction };
    return command('session-correct', 'gym.correctSession', args, (views) => {
      const session = views.drawn.get(recordKey('session', sessionId));
      if (!session || session.life?.[0] === 'dead') throw refusal('unknown-record');
      if (session.f.finishedAt === undefined) throw refusal('session-open');
      checkWorkout(views, args, sessionId);
      const standing = [...views.drawn.values()].filter((row) => row.t === 'set' && row.life?.[0] !== 'dead' && row.f?.sessionId?.[0] === sessionId);
      const unnamed = standing.filter((row) => !args.sets.some((set) => set.id === row.id));
      if (args.preserveOtherSets) for (const row of unnamed) {
        if (row.f.completedAt[0] < args.startedAt || row.f.completedAt[0] > args.finishedAt) throw refusal('bad-instant');
        if (args.sets.some((set) => set.exerciseId === row.f.exerciseId[0] && set.setNumber === row.v.setNumber)) throw refusal('invalid');
      }
      return [{ op: 'update', t: 'session', id: sessionId, f: { startedAt: args.startedAt, finishedAt: args.finishedAt,
        closedBy: 'finish', displayName: args.routineName } },
      ...args.sets.map(({ id, setNumber, kind, ...set }) => ({ op: standing.some((row) => row.id === id) ? 'update' : 'create', t: 'set', id,
        v: { setNumber }, f: { ...(standing.some((row) => row.id === id) ? {} : { sessionId, kind: kind ?? 'working', rpe: null, note: '' }), ...set } })),
      ...(args.preserveOtherSets ? [] : unnamed.map(({ id }) => ({ op: 'delete', t: 'set', id }))),
      ];
    }, () => ({ session: { id: sessionId, startedAt: args.startedAt, finishedAt: args.finishedAt }, sets: args.sets }));
  };
  return api;
}

export function useGymApi() {
  const engine = useSyncEngine();
  const records = useSyncRecords(SCOPE);
  const ready = records.firstPullComplete || records.drawn.length > 0;
  return useMemo(() => engine ? { ...createGymApi(engine), ready } : null, [engine, records.replica, ready]);
}

// A workout running on a phone keeps the mirror's sync close, until four idle hours close it.
export function gymLiveHint(engine, replica) {
  const rows = engine.observe(SCOPE).getSnapshot().drawn;
  const session = rows.find((row) => row.t === 'session' && row.life?.[0] !== 'dead' && row.f?.finishedAt === undefined);
  if (!session) return false;
  const activity = Math.max(session.f.startedAt[0], ...rows.filter((row) => row.t === 'set' && row.life?.[0] !== 'dead' && row.f?.sessionId?.[0] === session.id).map((row) => row.f.completedAt[0]));
  return Date.now() + (replica?.meta?.serverOffsetMs ?? 0) - activity < 4 * 3600_000;
}
