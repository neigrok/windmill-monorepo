// The workout the Coach room mirrors while one is open, when Coach itself stays closed.

import { entryLabel, nameOfMovement, planOf, planReadingOf, routineNameOf, slotRows, timeLabel } from '../log.js';
import { inLoggedOrder } from '../domain/training.js';
import { t } from '../i18n/index.js';

export function coachWorkout(session, sets = [], catalog = []) {
  const plan = planOf(session);
  const entries = Array.isArray(plan?.entries) ? plan.entries.filter((entry) => typeof entry?.exerciseId === 'string') : [];
  const ids = [...new Set([...entries.map((entry) => entry.exerciseId), ...sets.map((set) => set.exerciseId)])];
  const latest = [...sets].sort((left, right) => right.completedAt - left.completedAt)[0]?.exerciseId;
  const groups = ids.map((id) => {
    const entry = planReadingOf(session, id).entry;
    const logged = sets.filter((set) => set.exerciseId === id).sort(inLoggedOrder);
    const bodyweight = catalog.find((movement) => movement.id === id)?.equipment === 'bodyweight'
      && entry?.sets?.every((set) => set.weightKg == null || set.weightKg === 0);
    return { id, name: nameOfMovement(catalog, id),
      scheme: !entry ? null : bodyweight ? t('gym.coach.schemeBodyweight', { scheme: entryLabel(entry) }) : entryLabel(entry),
      rows: slotRows(logged, entry), targets: entry?.sets?.length ?? null };
  });
  const active = latest ?? groups.find((group) => group.rows.some((row) => row.kind === 'target'))?.id;
  const total = groups.length && groups.every((group) => group.targets !== null)
    ? groups.reduce((count, group) => count + group.targets, 0) : null;
  const remaining = groups.reduce((count, group) => count + group.rows.filter((row) => row.kind === 'target').length, 0);
  const count = t('gym.coach.setsLogged', { count: sets.length });
  return { name: routineNameOf(session) ?? t('gym.coach.freeSession'), started: timeLabel(session.startedAt), count,
    progress: total && remaining ? t('gym.coach.setOfTotal', { position: total - remaining + 1, total }) : count,
    groups, active };
}

export const COACH_TITLE = t('gym.coach.title');
