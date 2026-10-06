import { useMemo } from 'react';
import { useSyncEngine, useSyncRecords } from '../../platform/sync/react.js';
import { recordKey } from '../../platform/sync/core/rows.js';
import { jcs } from '../../platform/sync/core/jcs.js';
import { captureError } from '../../telemetry/sentry.js';
import { track } from '../../telemetry/beacon.js';
import { GymRefusal } from './errors.js';
import { BODY_BYTES, FULL_LINE, isBodyOverCap, isTitleOverCap, TITLE_MAX } from './notes/notes.js';
import { projectGym } from './syncProjections.js';
import { readPreferences } from './settings/preferences.js';

const SCOPE = 'self/gym';
const BASE = Symbol('gym-editor-base');
const READS = ['exercises', 'sessions', 'session', 'review', 'preferences', 'routines', 'routine',
  'proposals', 'proposal', 'notes', 'bodyweight', 'history', 'progress', 'record', 'lastTime', 'lastSets'];
const STEPS = { barbell: 2.5, dumbbell: 2, machine: 5, cable: 2.5, bodyweight: 2.5, kettlebell: 4 };
const OPERATIONS = new Set(['routine-create', 'routine-save', 'exercise-create', 'exercise-rename',
  'preferences-save', 'note-save', 'note-reorder', 'bodyweight-save', 'set-correct', 'delete', 'undo',
  'session-import', 'session-correct', 'proposal-apply', 'proposal-dismiss', 'refusal']);
const OUTCOMES = new Set(['saved-local', 'failed', 'held', 'undone', 'closed', 'refused']);

export function gymStep(operation, outcome) {
  if (!OPERATIONS.has(operation) || !OUTCOMES.has(outcome)) return;
  try { track('gym_action', { operation, outcome }); } catch { /* reporting cannot stop a save */ }
}

export function gymFailure(operation) {
  if (!OPERATIONS.has(operation) && operation !== 'projection') return;
  try { captureError('gym', `gym-${operation}`, '', '/gym'); } catch { /* reporting cannot stop a save */ }
}

const SENTENCES = {
  stale: 'This changed on another device. Read it again before saving.',
  cap: FULL_LINE,
  'session-open': 'that session is still running',
  'session-overlap': 'these times cross a session already in the log',
  'bad-instant': 'These times run past now or outside the workout.',
  'not-writable': 'Sign in to save to your training log.',
  'proposal-superseded': 'That proposal has been superseded.',
  'proposal-settled': 'That proposal has already been settled.',
};

const refusal = (code, { sentence = SENTENCES[code], overlapping = null } = {}) => new GymRefusal(code, { sentence, overlapping });

export function createGymApi(engine, { event = gymStep, failure = gymFailure } = {}) {
  const replica = engine.activeReplica();
  const snapshot = () => engine.observe(SCOPE).getSnapshot();
  const project = (rows = snapshot().stored, now = Date.now()) => projectGym(rows, {
    now, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const attachBase = (value, t, id) => {
    if (!value) return value;
    const row = snapshot().drawn.find((each) => each.t === t && each.id === id);
    value[BASE] = { replica, row: row ? structuredClone(row) : null };
    return value;
  };
  const commit = async (operation, build) => {
    try {
      const result = await engine.commit(SCOPE, (views) => {
        if (views.replica !== replica) throw refusal('not-writable');
        return build(views);
      });
      if (result.outcome?.refused) throw refusal(result.outcome.refused);
      event(operation, 'saved-local');
      return result.value;
    } catch (error) {
      event(operation, 'failed');
      if (!(error instanceof GymRefusal)) failure(operation);
      throw error;
    }
  };
  const guarded = (views, t, id, fields, base) => {
    const row = views.drawn.get(recordKey(t, id));
    if (!row || row.life?.[0] === 'dead') throw refusal('record-dead');
    const original = base?.[BASE];
    if (!original || original.replica !== replica || jcs(original.row?.born ?? null) !== jcs(row.born ?? null)) throw refusal('stale');
    for (const field of fields) if (jcs(original.row.f?.[field] ?? null) !== jcs(row.f?.[field] ?? null)) throw refusal('stale');
    return fields.map((field) => ({ t, id, field }));
  };
  const fieldsOfRoutine = ({ name, position = 0, entries }) => ({ name, position,
    entries: entries.map(({ exerciseId, sets, restSeconds }) => ({ exerciseId,
      ...(sets === undefined ? {} : { sets }), ...(restSeconds == null ? {} : { restSeconds }) })) });
  const api = { sync: true };
  for (const name of READS) api[name] = async (...args) => {
    try {
    const value = project()[name](...args);
    if (name === 'routine') return attachBase(value, 'routine', args[0]);
    if (name === 'routines') return value.map((routine) => attachBase(routine, 'routine', routine.id));
    if (name === 'notes') return value.map((note) => attachBase(note, 'note', note.id));
    return value;
    } catch (error) { failure('projection'); throw error; }
  };
  api.createRoutine = (routine) => commit('routine-create', () => ({
    gesture: { changes: [{ op: 'create', t: 'routine', id: routine.id, f: fieldsOfRoutine(routine) }] }, value: routine,
  }));
  api.replaceRoutine = (id, routine, base) => commit('routine-save', (views) => ({
    gesture: { changes: [{ op: 'update', t: 'routine', id, f: fieldsOfRoutine(routine) }],
      opts: { guard: guarded(views, 'routine', id, ['name', 'entries', 'position'], base) } }, value: routine,
  }));
  api.createExercise = (exercise) => commit('exercise-create', () => ({
    gesture: { changes: [{ op: 'create', t: 'exercise', id: exercise.id,
      f: { name: exercise.name, pattern: exercise.pattern, equipment: exercise.equipment,
        stepKg: STEPS[exercise.equipment] } }] }, value: { ...exercise, stepKg: STEPS[exercise.equipment], aliases: [] },
  }));
  api.renameExercise = (id, name) => commit('exercise-rename', (views) => {
    const custom = views.drawn.get(recordKey('exercise', id));
    return { gesture: { changes: [{ op: custom ? 'update' : 'write', t: custom ? 'exercise' : 'exerciseName', id, f: { name } }] },
      value: { ...project([...views.drawn.values()], views.now).exercises().find((each) => each.id === id), name } };
  });
  api.savePreferences = (document) => commit('preferences-save', () => ({
    gesture: { changes: [{ op: 'write', t: 'prefs', id: 'prefs', f: readPreferences(document) }] }, value: readPreferences(document),
  }));
  api.saveNote = (id, note, base) => commit('note-save', (views) => {
    if (!note.title.trim()) throw refusal('invalid', { sentence: 'a note needs a title' });
    if (isTitleOverCap(note.title)) throw refusal('invalid', { sentence: `a title runs to ${TITLE_MAX} characters` });
    if (isBodyOverCap(note.body)) throw refusal('invalid', { sentence: `a note runs to ${BODY_BYTES} bytes` });
    const exists = views.drawn.get(recordKey('note', id));
    const changes = [{ op: exists ? 'update' : 'create', t: 'note', id,
      f: { title: note.title, body: note.body },
      ...(!exists ? { anchor: { field: 'ord', below: project([...views.stored.values()], views.now).notes().at(-1)?.id ?? null } } : {}) }];
    const guard = exists ? guarded(views, 'note', id, ['title', 'body'], base) : [];
    return { gesture: { changes, opts: { guard } }, value: { id, ...note, position: base?.position ?? project([...views.stored.values()], views.now).notes().length } };
  });
  api.moveNote = (id, below) => commit('note-reorder', (views) => {
    const notes = project([...views.stored.values()], views.now).notes();
    const rest = notes.filter((note) => note.id !== id);
    const at = rest.findIndex((note) => note.id === below) + 1;
    if (rest.length === notes.length || (below !== null && at === 0)) throw refusal('unknown-record');
    return { gesture: { changes: [{ op: 'move', t: 'note', id, anchor: { field: 'ord', below } }] },
      value: [...rest.slice(0, at), notes.find((note) => note.id === id), ...rest.slice(at)].map((note, position) => ({ ...note, position })) };
  });
  api.saveBodyweight = (id, { weightKg }) => commit('bodyweight-save', (views) => ({
    gesture: { changes: [{ op: 'put', t: 'weighin', id, f: { kg: weightKg, recordedAt: views.now } }], opts: { retire: [{ t: 'weighin', id }] } },
    value: { dateLocal: id, weightKg, recordedAt: views.now },
  }));
  api.fixSet = (sessionId, id, fix) => commit('set-correct', (views) => {
    const row = views.drawn.get(recordKey('set', id));
    if (!row || row.life?.[0] === 'dead' || row.f?.sessionId?.[0] !== sessionId) throw refusal('unknown-record');
    const old = project([...views.drawn.values()], views.now).session(sessionId)?.sets.find((set) => set.id === id);
    return { gesture: { changes: [{ op: 'update', t: 'set', id, f: fix }] }, value: { ...old, ...fix } };
  });
  api.holdDeath = async (t, id) => {
    try {
      const answer = await engine.commit(SCOPE, (views) => {
        if (views.replica !== replica) throw refusal('not-writable');
        return { gesture: { changes: [{ op: 'delete', t, id }], opts: { hold: true } }, value: null };
      });
      const result = answer.outcome;
      if (result?.refused) throw refusal(result.refused);
      event('delete', 'held');
      return result.localIds[0]?.slice(0, result.localIds[0].lastIndexOf('/'));
    } catch (error) { event('delete', 'failed'); if (!(error instanceof GymRefusal)) failure('delete'); throw error; }
  };
  api.undoDeath = async (gestureId) => {
    try { const result = await engine.undo(gestureId); event('delete', result ? 'undone' : 'closed'); return result; }
    catch (error) { failure('undo'); throw error; }
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
      plan: routine ? { routine: routine.name, entries: fieldsOfRoutine(routine).entries } : null } },
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
      return [{ op: 'update', t: 'session', id: sessionId, f: { startedAt: args.startedAt, finishedAt: args.finishedAt,
        closedBy: 'finish', displayName: args.routineName } },
      ...args.sets.map(({ id, setNumber, ...set }) => ({ op: standing.some((row) => row.id === id) ? 'update' : 'create', t: 'set', id,
        v: { setNumber }, f: { ...(standing.some((row) => row.id === id) ? {} : { sessionId, kind: 'working', rpe: null, note: '' }), ...set } })),
      ...standing.filter((row) => !args.sets.some((set) => set.id === row.id)).map(({ id }) => ({ op: 'delete', t: 'set', id })),
      ];
    }, () => ({ session: { id: sessionId, startedAt: args.startedAt, finishedAt: args.finishedAt }, sets: args.sets }));
  };
  for (const verb of ['apply', 'dismiss']) api[`${verb}Proposal`] = (id) => command(`proposal-${verb}`, `gym.${verb}Proposal`, { proposalId: id }, (views) => {
    const projection = project([...views.drawn.values()], views.now);
    const proposal = projection.proposal(id);
    if (!proposal) throw refusal('unknown-record');
    if (proposal.state === 'superseded') throw refusal('proposal-superseded');
    if (proposal.state === (verb === 'apply' ? 'dismissed' : 'applied')) throw refusal('proposal-settled');
    const predict = [{ op: 'update', t: 'proposal', id, f: { state: verb === 'apply' ? 'applied' : 'dismissed', settledAt: views.now } }];
    if (verb === 'dismiss') return predict;
    if (proposal.intent === 'remove') return [...predict, { op: 'delete', t: 'routine', id: proposal.routineId }];
    return [...predict, { op: 'update', t: 'routine', id: proposal.routineId,
      f: { name: proposal.name, entries: proposal.changes.filter((change) => change.kind !== 'removed').map((change) => ({ exerciseId: change.exerciseId, ...change.after })) } }];
  }, (views) => ({ proposal: { ...project([...views.drawn.values()], views.now).proposal(id), state: verb === 'apply' ? 'applied' : 'dismissed' } }));
  return api;
}

export function useGymApi() {
  const engine = useSyncEngine();
  const records = useSyncRecords(SCOPE);
  const ready = records.firstPullComplete || records.drawn.length > 0;
  return useMemo(() => engine ? { ...createGymApi(engine), ready } : null, [engine, records.replica, ready]);
}

export function prepareGymSync(engine) {
  const previous = engine.liveHint;
  engine.liveHint = (replica) => {
    const rows = engine.observe(SCOPE).getSnapshot().drawn;
    const session = rows.find((row) => row.t === 'session' && row.life?.[0] !== 'dead' && row.f?.finishedAt === undefined);
    if (!session) return previous?.(replica) ?? false;
    const activity = Math.max(session.f.startedAt[0], ...rows.filter((row) => row.t === 'set' && row.life?.[0] !== 'dead' && row.f?.sessionId?.[0] === session.id).map((row) => row.f.completedAt[0]));
    return Date.now() + (replica?.meta?.serverOffsetMs ?? 0) - activity < 4 * 3600_000 || (previous?.(replica) ?? false);
  };
}
