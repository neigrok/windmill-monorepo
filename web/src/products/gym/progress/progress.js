import { Id, compareText } from '../../../platform/domain-kit/entities.js';
import { Instant, LocalDay } from '../../../platform/domain-kit/time.js';
import { Exercise } from '../domain/catalogue.js';
import { Session, TrainingSet } from '../domain/training.js';
import { EstimatedFact, MovementProgress, MovementSessionFact, PerformedFact, ProgressSession, Readout, StatsProgress } from '../domain/trainingReads.js';
import { GymUnits } from '../domain/units.js';
import { deviceZone } from '../gymRuntime.js';
import { agoLabel, fmt, setLoadLabel, shortDayLabel } from '../log.js';
import { inDisplayUnit, weightUnit } from '../units.js';

export const SESSION_GAP_DAYS = MovementProgress.gapDays;
export const SCRUB_HOLD_MS = 1500;
export const POINT_PITCH_PT = 24;

// Public log shares carry JSON facts; the signed-in room carries the same typed domain read.
function progressSnapshot(snapshot, now) {
  if (snapshot instanceof StatsProgress) return snapshot;
  const sessions = (snapshot?.sessions ?? []).flatMap((session) => {
    const movements = session.movements.filter((movement) => movement.workingSetCount > 0).map((movement) => {
      const fact = (value) => ({ id: new Id(value.setId, TrainingSet), weightKg: value.weightKg, reps: value.reps, rpe: value.rpe ?? null });
      const bodyweight = movement.bodyweightReps ?? [movement.mostReps, movement.heaviest].find((value) => value?.weightKg === 0);
      return new MovementSessionFact(new Id(movement.exerciseId, Exercise), movement.workingSetCount,
        new PerformedFact(fact(movement.heaviest)), new PerformedFact(fact(movement.mostReps ?? movement.heaviest)),
        movement.estimate ? new EstimatedFact(fact(movement.estimate), movement.estimate.e1rm) : null,
        bodyweight ? new PerformedFact(fact(bodyweight)) : null);
    });
    return movements.length ? [new ProgressSession(new Id(session.sessionId, Session), new Instant(session.startedAt), movements)] : [];
  });
  return StatsProgress.fromSessions(sessions, new Instant(snapshot?.asOf ?? now), snapshot?.isComplete ?? true);
}

function movementRead(snapshot, exerciseId, equipment, now) {
  const read = progressSnapshot(snapshot, now).movement(new Id(exerciseId, Exercise));
  const estimatesAllowed = ['barbell', 'dumbbell', 'machine', 'cable', 'kettlebell'].includes(equipment);
  return new MovementProgress(read.exerciseId, read.sessions.filter((point) => point.startedAt.ms <= now).map((point) =>
    estimatesAllowed ? point : { ...point, fact: new MovementSessionFact(point.fact.exerciseId, point.fact.workingSetCount,
      point.fact.heaviest, point.fact.mostReps, null, point.fact.bodyweightReps) }), read.isComplete);
}

function sessionFact(point) {
  return point ? { ...point.fact.json, mostReps: point.fact.mostReps.json, at: point.startedAt.ms, sessionId: point.id.record } : null;
}

export function estimateValue(weightKg, unit = weightUnit()) {
  return Readout.estimatedWeight(weightKg, GymUnits.reading(unit));
}

export function progressDateLabel(at, withYear = false) {
  return `${shortDayLabel(at)}${withYear ? ` ${new Date(at).getFullYear()}` : ''}`;
}

export function consistencyLine(snapshot, now = Date.now()) {
  const count = progressSnapshot(snapshot, now).consistency(new Instant(now), deviceZone);
  return count === null ? null : `Trained ${count} of the last 4 weeks`;
}

export function movementProgress(snapshot, exerciseId, { window = '12', now = Date.now(), equipment, unit = weightUnit() } = {}) {
  const all = movementRead(snapshot, exerciseId, equipment, now);
  const read = window === 'all' ? all : all.chartWindow(new Instant(now), deviceZone);
  const visible = read.sessions.map(sessionFact);
  const latest = sessionFact(read.latest);
  const best = sessionFact(read.best);
  const heaviest = sessionFact(read.heaviest);
  const bodyweight = read.bodyweightReps;
  const assisted = equipment === 'bodyweight' || (!best && visible.some((row) => row.heaviest.weightKg <= 0));
  const showYears = new Date(visible[0]?.at ?? now).getFullYear() !== new Date(now).getFullYear();
  const dateLabel = (at) => progressDateLabel(at, showYears);
  const standing = all.best;
  const gaps = new Map(read.gaps(deviceZone).map(({ before, after }) => [before.id.record, after.id.record]));
  const points = read.estimates.map((point) => ({
    key: point.id.record,
    at: point.startedAt.ms,
    value: inDisplayUnit(point.fact.estimate.e1rm, unit),
    color: standing && point.id.equals(standing.id) ? 'var(--pr-ink)' : 'var(--color-brand)',
    gapAfter: gaps.get(point.id.record) ?? null,
    label: `${estimateValue(point.fact.estimate.e1rm, unit)} ${unit} est · ${dateLabel(point.startedAt.ms)} · ${setLoadLabel(point.fact.estimate, unit)}`,
  }));
  const count = visible.length;
  const windowLabel = `${window === 'all' ? 'the whole series' : 'last 12 weeks'} · ${points.length} ${points.length === 1 ? 'session' : 'sessions'}`;
  const sparseLine = `${count} ${count === 1 ? 'session' : 'sessions'}${count ? ` · since ${dateLabel(visible[0].at)}` : ''}`;
  const start = LocalDay.in(new Instant(now), deviceZone).adding(-84);
  return {
    exerciseId, sessions: visible, points, latest, best, heaviest, windowLabel, sparseLine, assisted, showYears,
    mostRepsLine: bodyweight ? `most reps ${bodyweight.fact.bodyweightReps.reps} · bodyweight · ${dateLabel(bodyweight.startedAt.ms)}` : null,
    signedLoadLine: heaviest && heaviest.heaviest.weightKg !== 0 ? `heaviest ${heaviest.heaviest.weightKg > 0 ? 'added +' : 'assisted −'}${fmt(Math.abs(heaviest.heaviest.weightKg), unit)} · ${dateLabel(heaviest.at)}` : null,
    domain: { from: window === 'all' ? all.sessions[0]?.startedAt.ms ?? now : new Date(start.year, start.month - 1, start.day).getTime(), to: now },
    chartReady: read.hasChart(deviceZone),
    latestLine: latest ? `e1RM ${estimateValue(latest.estimate.e1rm, unit)} · ${agoLabel(latest.at, now)}` : null,
    bestLine: best ? `best e1RM ${estimateValue(best.estimate.e1rm, unit)} · ${dateLabel(best.at)}` : null,
    sparseBest: best ? `Best so far: e1RM ${estimateValue(best.estimate.e1rm, unit)}, from ${setLoadLabel(best.estimate, unit)} on ${dateLabel(best.at)}.` : null,
    heaviestLine: heaviest ? `heaviest ${setLoadLabel(heaviest.heaviest, unit)} · ${dateLabel(heaviest.at)}` : null,
  };
}

export function progressCards(snapshot, catalog, now = Date.now(), unit = weightUnit()) {
  const progress = progressSnapshot(snapshot, now);
  const ids = new Set(progress.sessions.flatMap((session) => session.movements.map((movement) => movement.exerciseId.record)));
  const movements = new Map(catalog.map((movement) => [movement.id, movement]));
  return [...ids].map((id) => ({ ...movementProgress(progress, id, { now, equipment: movements.get(id)?.equipment, unit }), name: movements.get(id)?.name ?? id }))
    .filter((card) => card.sessions.length > 0)
    .sort((a, b) => Number(b.chartReady) - Number(a.chartReady) || b.sessions.at(-1).at - a.sessions.at(-1).at || Number(a.assisted) - Number(b.assisted) || compareText(a.exerciseId, b.exerciseId));
}

export function joinsSessions(from, to) {
  return from.gapAfter !== to.key;
}

export function sessionGapLabel(from, to, withYear = new Date(from.at).getFullYear() !== new Date(to.at).getFullYear()) {
  return `no session · ${progressDateLabel(from.at, withYear)} – ${progressDateLabel(to.at, withYear)}`;
}

export function recordProgress(snapshot, exerciseId, equipment) {
  const read = movementRead(snapshot, exerciseId, equipment, Date.now());
  const estimate = (point) => ({ ...point.fact.estimate.json, at: point.startedAt.ms });
  return {
    bestE1rm: read.best ? estimate(read.best) : undefined,
    heaviest: read.heaviest ? { ...read.heaviest.fact.heaviest.json, at: read.heaviest.startedAt.ms } : undefined,
    records: read.records.map(estimate).reverse(),
  };
}
