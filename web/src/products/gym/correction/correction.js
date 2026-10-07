import { Path, Violation } from '../../../platform/domain-kit/values.js';
import { GymRules, SetRules } from '../domain/gymRules.js';
import { MAX_SESSION_SETS } from '../domain/trainingActions.js';
import { gymMoment } from '../gymRuntime.js';
import { routineNameOf, timeLabel } from '../log.js';

export function setFields(set) {
  return { weightKg: String(set.weightKg), reps: String(set.reps), rpe: set.rpe == null ? '' : String(set.rpe), note: set.note ?? '' };
}

export function readSetFields(fields) {
  const typedLoad = fields.weightKg.trim().replace('−', '-').replace(',', '.');
  const weightKg = Number(typedLoad);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(typedLoad)) return { field: 'weightKg', reason: 'Enter a load from −500 to 500 kg.' };
  const reps = Number(fields.reps);
  const rpe = fields.rpe === '' ? null : Number(fields.rpe);
  try {
    SetRules.weightKg.apply(weightKg, new Path('weightKg'));
    if (!/^\d+$/.test(fields.reps.trim())) return { field: 'reps', reason: 'Enter 1 to 500 reps.' };
    SetRules.reps.apply(reps, new Path('reps'));
    SetRules.rpe.applyOptional(rpe, new Path('rpe'));
    SetRules.note.apply(fields.note, new Path('note'));
  } catch (error) {
    if (!(error instanceof Violation)) throw error;
    const field = error.path.text;
    if (field === 'weightKg') {
      if (error.reason.kind === 'above') return { field, reason: 'Over 500 kg — check the number.' };
      if (error.reason.kind === 'below') return { field, reason: 'Below −500 kg — check the number.' };
      return { field, reason: 'Enter a load from −500 to 500 kg.' };
    }
    if (field === 'reps') return { field, reason: 'Enter 1 to 500 reps.' };
    if (field === 'rpe') return { field, reason: 'Enter an RPE from 1 to 10.' };
    return { field, reason: error.reason.kind === 'nul' ? 'Remove the unsupported character from this set note.' : 'A set note runs to 4000 bytes.' };
  }
  // Keep the typed precision so an untouched field does not become an edit; the action normalises a write.
  return { value: { weightKg, reps, rpe, note: fields.note } };
}

export function correctionDraft(session, sets) {
  return {
    routineName: routineNameOf(session) ?? '', date: gymMoment(session.startedAt).today.text, time: timeLabel(session.startedAt),
    sets: sets.map((set) => ({ ...set, fields: setFields(set) })),
  };
}

export function correctionWrite(session, draft, requestId) {
  const minute = new Date(`${draft.date}T${draft.time}`).getTime();
  const sameDate = draft.date === gymMoment(session.startedAt).today.text;
  const sameTime = draft.time === timeLabel(session.startedAt);
  if (!Number.isFinite(minute) || gymMoment(minute).today.text !== draft.date || timeLabel(minute) !== draft.time) return { field: 'date', reason: 'Enter a valid local date and time for this workout.' };
  const startedAt = sameDate && sameTime ? session.startedAt : minute + (sameTime ? session.startedAt % 60000 : 0);
  const finishedAt = startedAt + session.finishedAt - session.startedAt;
  if (draft.sets.length > MAX_SESSION_SETS) return { reason: `A workout can hold up to ${MAX_SESSION_SETS} sets.` };
  if (!draft.sets.length) return { reason: 'Keep at least one set, or delete this workout.' };
  try {
    GymRules.spec('gym.correctSession.routineName').apply(draft.routineName, new Path('routineName'));
  } catch (error) {
    if (!(error instanceof Violation)) throw error;
    return { field: 'routineName', reason: error.reason.kind === 'nul' ? 'Remove the unsupported character from this workout name.' : 'A workout name runs to 240 bytes.' };
  }
  const positions = new Map();
  const sets = [];
  for (const set of draft.sets) {
    const parsed = readSetFields(set.fields);
    if (parsed.reason) return { ...parsed, setId: set.id };
    const position = (positions.get(set.exerciseId) ?? 0) + 1;
    positions.set(set.exerciseId, position);
    sets.push({
      id: set.id, exerciseId: set.exerciseId, setNumber: position,
      ...parsed.value,
      completedAt: set.completedAt == null ? finishedAt : Math.max(startedAt, Math.min(finishedAt, set.completedAt + startedAt - session.startedAt)),
    });
  }
  return { value: { requestId, startedAt, finishedAt, routineName: draft.routineName, sets } };
}

export function correctionScheme(sets) {
  const reps = sets.map((set) => Number(set.fields.reps));
  const loads = sets.map((set) => Number(set.fields.weightKg.replace(',', '.')));
  if (sets.some((set) => !set.fields.reps.trim() || !set.fields.weightKg.trim()) || [...reps, ...loads].some((value) => !Number.isFinite(value))) return `${sets.length} sets`;
  const range = (values) => {
    const low = Math.min(...values);
    const high = Math.max(...values);
    return low === high ? String(low) : `${low}–${high}`;
  };
  return `${sets.length} × ${range(reps)} · ${loads.every((value) => value === 0) ? 'bodyweight' : range(loads)}`;
}
