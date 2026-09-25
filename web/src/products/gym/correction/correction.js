import { dateLocalOf } from '../bodyweight/bodyweight.js';
import { setNoteRefusal } from '../fix.js';
import { routineNameOf, timeLabel } from '../log.js';

export function setFields(set) {
  return { weightKg: String(set.weightKg), reps: String(set.reps), rpe: set.rpe == null ? '' : String(set.rpe), note: set.note ?? '' };
}

export function readSetFields(fields) {
  const typedLoad = fields.weightKg.trim().replace('−', '-').replace(',', '.');
  const weightKg = Number(typedLoad);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(typedLoad) || !Number.isFinite(weightKg)) return { field: 'weightKg', reason: 'Enter a load from −500 to 500 kg.' };
  if (weightKg > 500) return { field: 'weightKg', reason: 'Over 500 kg — check the number.' };
  if (weightKg < -500) return { field: 'weightKg', reason: 'Below −500 kg — check the number.' };
  const reps = Number(fields.reps);
  if (!/^\d+$/.test(fields.reps.trim()) || !Number.isInteger(reps) || reps < 1 || reps > 500) return { field: 'reps', reason: 'Enter 1 to 500 reps.' };
  const rpe = fields.rpe === '' ? null : Number(fields.rpe);
  if (rpe !== null && (!Number.isFinite(rpe) || rpe < 1 || rpe > 10 || Math.abs(rpe * 10 - Math.round(rpe * 10)) > 1e-9)) return { field: 'rpe', reason: 'Enter an RPE from 1 to 10 with at most one decimal.' };
  const reason = setNoteRefusal(fields.note);
  if (reason) return { field: 'note', reason };
  return { value: { weightKg, reps, rpe, note: fields.note } };
}

export function correctionDraft(session, sets) {
  return {
    routineName: routineNameOf(session) ?? '', date: dateLocalOf(session.startedAt), time: timeLabel(session.startedAt),
    sets: sets.map((set) => ({ ...set, fields: setFields(set) })),
  };
}

export function correctionWrite(session, draft, requestId, now = Date.now()) {
  const minute = new Date(`${draft.date}T${draft.time}`).getTime();
  const sameDate = draft.date === dateLocalOf(session.startedAt);
  const sameTime = draft.time === timeLabel(session.startedAt);
  if (!Number.isFinite(minute) || dateLocalOf(minute) !== draft.date || timeLabel(minute) !== draft.time) return { field: 'date', reason: 'Enter a valid local date and time for this workout.' };
  const startedAt = sameDate && sameTime ? session.startedAt : minute + (sameTime ? session.startedAt % 60000 : 0);
  const finishedAt = startedAt + session.finishedAt - session.startedAt;
  if (finishedAt > now) return { field: 'date', reason: 'These times run past now.' };
  if (draft.sets.length > 200) return { reason: 'A workout can hold up to 200 sets.' };
  if (!draft.sets.length) return { reason: 'Keep at least one set, or delete this workout.' };
  if ([...draft.routineName.trim()].length > 60) return { field: 'routineName', reason: 'A workout name runs to 60 characters.' };
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
  return { value: { requestId, startedAt, finishedAt, routineName: draft.routineName.trim(), sets } };
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
