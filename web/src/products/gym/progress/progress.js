import { agoLabel, fmt, setLoadLabel, shortDayLabel } from '../log.js';
import { inDisplayUnit, weightUnit } from '../units.js';

export const SESSION_GAP_DAYS = 21;
export const SCRUB_HOLD_MS = 1500;
export const POINT_PITCH_PT = 24;
const DAY_MS = 86_400_000;

export function estimateValue(weightKg, unit = weightUnit()) {
  return String(Math.round(inDisplayUnit(weightKg, unit) * 10) / 10);
}

export function progressDateLabel(at, withYear = false) {
  return `${shortDayLabel(at)}${withYear ? ` ${new Date(at).getFullYear()}` : ''}`;
}

export function consistencyLine(snapshot, now = Date.now()) {
  const weekOf = (at) => {
    const date = new Date(at);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    return date.getTime();
  };
  const weeks = new Set((snapshot?.sessions ?? [])
    .filter((session) => session.movements.some((movement) => movement.workingSetCount > 0))
    .map((session) => weekOf(session.startedAt)));
  if (weeks.size < 2) return null;
  const first = new Date(weekOf(now));
  first.setDate(first.getDate() - 21);
  const count = [...weeks].filter((week) => week >= first.getTime() && week <= weekOf(now)).length;
  return count ? `Trained ${count} of the last 4 weeks` : null;
}

export function movementProgress(snapshot, exerciseId, { window = '12', now = Date.now(), equipment, unit = weightUnit() } = {}) {
  const estimatesAllowed = ['barbell', 'dumbbell', 'machine', 'cable', 'kettlebell'].includes(equipment);
  const sessions = (snapshot?.sessions ?? []).flatMap((session) => {
    const movement = session.movements.find((entry) => entry.exerciseId === exerciseId);
    return movement ? [{ ...movement, estimate: estimatesAllowed ? movement.estimate : undefined, at: session.startedAt, sessionId: session.sessionId }] : [];
  }).sort((a, b) => a.at - b.at || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 84);
  const visible = sessions.filter((session) => session.at <= now && (window === 'all' || session.at >= start.getTime()));
  const estimates = sessions.filter((session) => session.estimate);
  const standing = estimates.reduce((best, row) => !best || row.estimate.e1rm > best.estimate.e1rm ? row : best, null);
  const plotted = visible.filter((session) => session.estimate);
  const latest = plotted.at(-1) ?? null;
  const best = plotted.reduce((top, row) => !top || row.estimate.e1rm > top.estimate.e1rm ? row : top, null);
  const heaviest = visible.reduce((top, row) => {
    if (!row.heaviest) return top;
    if (!top || row.heaviest.weightKg > top.heaviest.weightKg) return row;
    if (row.heaviest.weightKg === top.heaviest.weightKg && row.heaviest.reps > top.heaviest.reps) return row;
    return top;
  }, null);
  const mostReps = visible.reduce((top, row) => {
    const fact = row.mostReps ?? (row.heaviest?.weightKg === 0 ? row.heaviest : null);
    if (!fact || (top && top.fact.reps >= fact.reps)) return top;
    return { fact, at: row.at };
  }, null);
  const assisted = equipment === 'bodyweight' || (!best && visible.some((row) => row.heaviest?.weightKg <= 0));
  const showYears = new Date(visible[0]?.at ?? now).getFullYear() !== new Date(now).getFullYear();
  const dateLabel = (at) => progressDateLabel(at, showYears);
  const points = plotted.map((row) => ({
    key: row.sessionId,
    at: row.at,
    value: inDisplayUnit(row.estimate.e1rm, unit),
    color: row.sessionId === standing?.sessionId ? 'var(--pr-ink)' : 'var(--color-brand)',
    label: `${estimateValue(row.estimate.e1rm, unit)} ${unit} est · ${dateLabel(row.at)} · ${setLoadLabel(row.estimate, unit)}`,
  }));
  const count = visible.length;
  const windowLabel = `${window === 'all' ? 'the whole series' : 'last 12 weeks'} · ${plotted.length} ${plotted.length === 1 ? 'session' : 'sessions'}`;
  const sparseLine = `${count} ${count === 1 ? 'session' : 'sessions'}${count ? ` · since ${dateLabel(visible[0].at)}` : ''}`;
  return {
    exerciseId, sessions: visible, points, latest, best, heaviest, windowLabel, sparseLine, assisted, showYears,
    mostRepsLine: mostReps ? `most reps ${mostReps.fact.reps} · bodyweight · ${dateLabel(mostReps.at)}` : null,
    signedLoadLine: heaviest && heaviest.heaviest.weightKg !== 0 ? `heaviest ${heaviest.heaviest.weightKg > 0 ? 'added +' : 'assisted −'}${fmt(Math.abs(heaviest.heaviest.weightKg), unit)} · ${dateLabel(heaviest.at)}` : null,
    domain: { from: window === 'all' ? sessions[0]?.at ?? now : start.getTime(), to: now },
    chartReady: points.length >= 4 && points.at(-1).at - points[0].at >= 21 * DAY_MS,
    latestLine: latest ? `e1RM ${estimateValue(latest.estimate.e1rm, unit)} · ${agoLabel(latest.at, now)}` : null,
    bestLine: best ? `best e1RM ${estimateValue(best.estimate.e1rm, unit)} · ${dateLabel(best.at)}` : null,
    sparseBest: best ? `Best so far: e1RM ${estimateValue(best.estimate.e1rm, unit)}, from ${setLoadLabel(best.estimate, unit)} on ${dateLabel(best.at)}.` : null,
    heaviestLine: heaviest ? `heaviest ${setLoadLabel(heaviest.heaviest, unit)} · ${dateLabel(heaviest.at)}` : null,
  };
}

export function progressCards(snapshot, catalog, now = Date.now(), unit = weightUnit()) {
  const ids = new Set((snapshot?.sessions ?? []).flatMap((session) => session.movements.map((movement) => movement.exerciseId)));
  const movements = new Map(catalog.map((movement) => [movement.id, movement]));
  return [...ids].map((id) => ({ ...movementProgress(snapshot, id, { now, equipment: movements.get(id)?.equipment, unit }), name: movements.get(id)?.name ?? id }))
    .filter((card) => card.sessions.length > 0)
    .sort((a, b) => Number(b.chartReady) - Number(a.chartReady) || b.sessions.at(-1).at - a.sessions.at(-1).at || Number(a.assisted) - Number(b.assisted) || (a.exerciseId < b.exerciseId ? -1 : a.exerciseId > b.exerciseId ? 1 : 0));
}

export function joinsSessions(from, to) {
  return to.at - from.at <= SESSION_GAP_DAYS * DAY_MS;
}

export function sessionGapLabel(from, to, withYear = new Date(from.at).getFullYear() !== new Date(to.at).getFullYear()) {
  return `no session · ${progressDateLabel(from.at, withYear)} – ${progressDateLabel(to.at, withYear)}`;
}

export function recordProgress(snapshot, exerciseId, equipment) {
  const model = movementProgress(snapshot, exerciseId, { window: 'all', equipment });
  let top = null;
  const records = [];
  for (const session of model.sessions) {
    if (!session.estimate || (top !== null && session.estimate.e1rm <= top)) continue;
    top = session.estimate.e1rm;
    records.push({ ...session.estimate, at: session.at });
  }
  return {
    bestE1rm: model.best ? { ...model.best.estimate, at: model.best.at } : undefined,
    heaviest: model.heaviest ? { ...model.heaviest.heaviest, at: model.heaviest.at } : undefined,
    records: records.reverse(),
  };
}
