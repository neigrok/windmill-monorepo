import { fmt } from '../log.js';
import { weightUnit } from '../units.js';

export function historyQuery(hash) {
  const query = new URLSearchParams((hash ?? '').split('?')[1] ?? '');
  const year = /^\d{4}$/.test(query.get('year') ?? '') ? Number(query.get('year')) : null;
  const month = /^(0[1-9]|1[0-2])$/.test(query.get('month') ?? '') && year ? Number(query.get('month')) : null;
  const exercise = query.get('exercise') || '';
  const routine = query.get('routine') || '';
  return { year, month, exercise, routine, density: query.get('density') === 'compact' ? 'compact' : 'comfortable', selected: query.get('session') || null };
}

export function historyHref(filters, changes = {}) {
  const value = { ...filters, ...changes };
  const query = new URLSearchParams();
  if (value.year) query.set('year', String(value.year));
  if (value.year && value.month) query.set('month', String(value.month).padStart(2, '0'));
  if (value.exercise) query.set('exercise', value.exercise);
  if (value.routine) query.set('routine', value.routine);
  if (value.density === 'compact') query.set('density', 'compact');
  if (value.selected) query.set('session', value.selected);
  return `#/gym/log${query.size ? `?${query}` : ''}`;
}

export function historyScope(filters) {
  return {
    ...(filters.year ? { from: new Date(filters.year, filters.month ? filters.month - 1 : 0, 1).getTime(), until: new Date(filters.month ? filters.year : filters.year + 1, filters.month ?? 0, 1).getTime() } : {}),
    ...(filters.exercise ? { exercise: filters.exercise } : {}),
    ...(filters.routine ? { routine: filters.routine } : {}),
  };
}

export function historyTotals(summary, unit = weightUnit()) {
  if (!summary) return null;
  return `${summary.sessions} ${summary.sessions === 1 ? 'workout' : 'workouts'} · ${summary.sets} sets · ${summary.reps} reps · loads in ${unit}`;
}

export function emptyHistoryLine(filters, exercises = [], routines = []) {
  const movement = exercises.find((entry) => entry.id === filters.exercise)?.name;
  const routine = routines.find((entry) => entry.id === filters.routine)?.name;
  const date = filters.year ? (filters.month ? new Date(filters.year, filters.month - 1, 1).toLocaleDateString('en', { month: 'long', year: 'numeric' }) : String(filters.year)) : null;
  if ((filters.exercise && !movement) || (filters.routine && !routine)) return 'No workouts match these filters.';
  return `No ${movement ? `${movement} sessions` : 'workouts'}${routine ? ` from ${routine}` : ''}${date ? ` in ${date}` : ''}.`;
}

export function yearsOf(sessions, byMonth = false) {
  const years = new Map();
  for (const session of sessions) {
    const date = new Date(session.startedAt);
    const year = byMonth ? date.toLocaleDateString('en', { month: 'long', year: 'numeric' }) : date.getFullYear();
    if (!years.has(year)) years.set(year, []);
    years.get(year).push(session);
  }
  return [...years].map(([year, rows]) => ({ year, sessions: rows }));
}

export function collapsedScheme(sets) {
  if (sets.length < 2 || sets.some((set) => set.kind !== 'working')) return null;
  const first = sets[0];
  if (!sets.every((set) => set.weightKg === first.weightKg && set.reps === first.reps && set.rpe === first.rpe && !set.note && set.kind === first.kind)) return null;
  return `${sets.length} × ${first.reps} · ${first.weightKg === 0 ? 'bodyweight' : fmt(first.weightKg)}`;
}

export function workoutTotals(sets) {
  const working = sets.filter((set) => set.kind === 'working');
  return { sets: working.length, reps: working.reduce((sum, set) => sum + set.reps, 0), tonnageKg: working.reduce((sum, set) => sum + Math.max(0, set.weightKg) * set.reps, 0) };
}
