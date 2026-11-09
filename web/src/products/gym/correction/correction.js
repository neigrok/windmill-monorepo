import { Path, Violation } from '../../../platform/domain-kit/values.js';
import { GymRules, SetRules } from '../domain/gymRules.js';
import { MAX_SESSION_SETS } from '../domain/trainingActions.js';
import { gymMoment } from '../gymRuntime.js';
import { t } from '../i18n/index.js';
import { routineNameOf, timeLabel } from '../log.js';

export function setFields(set) {
  return { weightKg: String(set.weightKg), reps: String(set.reps), rpe: set.rpe == null ? '' : String(set.rpe), note: set.note ?? '' };
}

export function readSetFields(fields) {
  const typedLoad = fields.weightKg.trim().replace('−', '-').replace(',', '.');
  const weightKg = Number(typedLoad);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(typedLoad)) return { field: 'weightKg', reason: t('gym.correction.notNumber') };
  const reps = Number(fields.reps);
  const rpe = fields.rpe === '' ? null : Number(fields.rpe);
  try {
    SetRules.weightKg.apply(weightKg, new Path('weightKg'));
    if (!/^\d+$/.test(fields.reps.trim())) return { field: 'reps', reason: t('gym.correction.repsRange') };
    SetRules.reps.apply(reps, new Path('reps'));
    SetRules.rpe.applyOptional(rpe, new Path('rpe'));
    SetRules.note.apply(fields.note, new Path('note'));
  } catch (error) {
    if (!(error instanceof Violation)) throw error;
    const field = error.path.text;
    if (field === 'weightKg') {
      return { field, reason: t('gym.correction.notNumber') };
    }
    if (field === 'reps') return { field, reason: t('gym.correction.repsRange') };
    if (field === 'rpe') return { field, reason: t('gym.correction.rpeRange') };
    return { field, reason: error.reason.kind === 'nul' ? t('gym.correction.noteCharacter') : t('gym.correction.noteBytes') };
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
  if (!Number.isFinite(minute) || gymMoment(minute).today.text !== draft.date || timeLabel(minute) !== draft.time) return { field: 'date', reason: t('gym.correction.invalidWhen') };
  const startedAt = sameDate && sameTime ? session.startedAt : minute + (sameTime ? session.startedAt % 60000 : 0);
  const finishedAt = startedAt + session.finishedAt - session.startedAt;
  if (draft.sets.length > MAX_SESSION_SETS) return { reason: t('gym.correction.setLimit', { max: MAX_SESSION_SETS }) };
  if (!draft.sets.length) return { reason: t('gym.correction.keepOneSet') };
  try {
    GymRules.spec('gym.correctSession.routineName').apply(draft.routineName, new Path('routineName'));
  } catch (error) {
    if (!(error instanceof Violation)) throw error;
    return { field: 'routineName', reason: error.reason.kind === 'nul' ? t('gym.correction.nameCharacter') : t('gym.correction.nameBytes') };
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
  if (sets.some((set) => !set.fields.reps.trim() || !set.fields.weightKg.trim()) || [...reps, ...loads].some((value) => !Number.isFinite(value))) return t('gym.correction.setCount', { count: sets.length });
  const range = (values) => {
    const low = Math.min(...values);
    const high = Math.max(...values);
    return low === high ? String(low) : `${low}–${high}`;
  };
  return `${sets.length} × ${range(reps)} · ${loads.every((value) => value === 0) ? t('gym.correction.bodyweight') : range(loads)}`;
}
