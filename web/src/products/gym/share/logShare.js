export function logShareRequest(draft, id) {
  const common = { id, mode: draft.mode, scope: draft.scope };
  if (!['snapshot', 'live'].includes(draft.mode)) return { error: 'Choose snapshot or live updates.' };
  if (draft.scope === 'all') return { value: common };
  if (draft.scope !== 'range') return { error: 'Choose the history to share.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.from) || !/^\d{4}-\d{2}-\d{2}$/.test(draft.until)) {
    return { error: 'Choose both dates for the shared range.' };
  }
  const from = new Date(`${draft.from}T00:00:00`);
  const until = new Date(`${draft.until}T00:00:00`);
  const dateOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(until.getTime()) || dateOf(from) !== draft.from || dateOf(until) !== draft.until || from > until) {
    return { error: 'The end date must be on or after the start date.' };
  }
  until.setDate(until.getDate() + 1);
  return { value: { ...common, from: from.getTime(), until: until.getTime() } };
}

export function shareHistoryScope(share, filters = {}) {
  const from = [share.from, filters.from].filter(Number.isFinite);
  const until = [share.until, filters.until].filter(Number.isFinite);
  return { ...filters, ...(from.length ? { from: Math.max(...from) } : {}), ...(until.length ? { until: Math.min(...until) } : {}) };
}

export function logShareDescription(share) {
  const mode = share.mode === 'live' ? 'Live updates' : 'Snapshot';
  if (share.scope !== 'range') return `${mode} · entire history`;
  return `${mode} · ${shareDateLabel(share.from)} – ${shareDateLabel(share.until - 1)}`;
}

export function shareDateLabel(at) {
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function publicLogHref(token, filters = {}) {
  const query = new URLSearchParams();
  if (filters.year) query.set('year', String(filters.year));
  if (filters.year && filters.month) query.set('month', String(filters.month).padStart(2, '0'));
  if (filters.exercise) query.set('exercise', filters.exercise);
  if (filters.routine) query.set('routine', filters.routine);
  if (filters.density === 'compact') query.set('density', 'compact');
  if (filters.selected) query.set('session', filters.selected);
  return `#/gym/shared-log/${encodeURIComponent(token)}${query.size ? `?${query}` : ''}`;
}

export function sharedSetScheme(sets) {
  if (sets.length < 2) return null;
  const first = sets[0];
  if (!sets.every((set) => set.weightKg === first.weightKg && set.reps === first.reps && set.rpe === first.rpe)) return null;
  return `${sets.length} × ${first.reps} · ${first.weightKg === 0 ? 'bodyweight' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(first.weightKg)}`;
}
