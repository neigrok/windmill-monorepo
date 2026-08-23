// A movement's record as pure rules: which blocks there is anything to draw, and how a number becomes
// a bar. Every number arrives already made off the wire; nothing here is arithmetic about training.
// Epley is undefined at or below zero load and the wire says so by omission — a bodyweight or
// band-assisted movement carries no `bestE1rm`, no `e1rmSeries` and no `records`, and draws no tile,
// no chart and no dash inside a chart frame. The bar scale starts at zero: a bar's length is its value.

import { agoLabel, e1rmLabel, fmt, setLoadLabel, shortDayLabel } from './log.js';
import { weightUnit } from './units.js';

const round2 = (value) => Math.round(value * 100) / 100;

const countLabel = (count, one, many) => `${count} ${count === 1 ? one : many}`;

export const NEVER_LOGGED = 'You haven’t worked this movement yet.';
export const NEVER_LOGGED_LINE = 'The first set you log against it lands here.';

// 'today' and 'yesterday' by name, every other day by its date.
export function whenOf(ms, now) {
  const ago = agoLabel(ms, now);
  if (ago === 'today' || ago === 'yesterday') return ago;
  return shortDayLabel(ms);
}

// `sessionCount` counts sessions the movement was WORKED in; `recentDays` holds every day it was
// trained in bar a warmup. A movement logged only as a drop counts zero and still has sets to show.
function inTheLog(record) {
  return record.sessionCount > 0 || (record.recentDays ?? []).length > 0;
}

export function subheadOf(record) {
  const routines = record.routineCount === 0
    ? 'in no routine'
    : `in ${countLabel(record.routineCount, 'routine', 'routines')}`;
  if (record.sessionCount > 0) {
    const sessions = countLabel(record.sessionCount, 'session', 'sessions');
    return `${record.exercise.equipment} · ${routines} · ${sessions}`;
  }
  // 'never logged' rather than '0 sessions', and guarded: a drop set is a set somebody did.
  const sessions = inTheLog(record) ? 'no working sets' : 'never logged';
  return `${record.exercise.equipment} · ${routines} · ${sessions}`;
}

// Either tile may be absent.
export function tilesOf(record, now) {
  const tiles = [];
  if (record.bestE1rm) {
    tiles.push({
      label: 'best e1RM',
      value: fmt(record.bestE1rm.e1rm),
      sub: `${whenOf(record.bestE1rm.at, now)} · ${setLoadLabel(record.bestE1rm)}`,
      standing: true,
    });
  }
  if (record.heaviest) {
    // Zero is the absence of a load, so the heaviest bodyweight movement is a number of REPS.
    const { weightKg, reps } = record.heaviest;
    tiles.push(weightKg === 0
      ? { label: 'heaviest', value: String(reps), sub: 'reps · bodyweight', standing: false }
      : { label: 'heaviest', value: fmt(weightKg), sub: `${weightUnit()} · for ${reps}`, standing: false });
  }
  return tiles;
}

// Bars, never a line: a line between discrete sessions implies days that never happened. Null when
// there is nothing to plot, and the page then draws no frame, no axis and no empty box.
export function chartOf(record, now) {
  const series = record.e1rmSeries ?? [];
  if (series.length === 0) return null;
  const top = Math.max(...series.map((point) => point.e1rm));
  // Written as `!(top > 0)` and not `top <= 0`: a point with no estimate makes the top NaN, every
  // comparison with NaN is false, and the bars would come out `height:NaN%`.
  if (!(top > 0)) return null;
  // At most one gold bar, and a best set older than this window leaves none at all.
  const standingAt = record.bestE1rm?.at ?? null;
  return {
    bars: series.map((point) => ({
      at: point.at,
      pct: round2((point.e1rm / top) * 100),
      standing: point.at === standingAt,
      label: `${whenOf(point.at, now)} · ${setLoadLabel(point)} · ${e1rmLabel(point.e1rm)}`,
    })),
    top,
    // The ends of the window, spelled as the days actually on screen.
    from: shortDayLabel(series[0].at),
    to: shortDayLabel(series[series.length - 1].at),
  };
}

// Every session that beat every session before it, newest first, over the whole log.
export function recordsOf(record, now) {
  return (record.records ?? []).map((mark, index) => ({
    at: mark.at,
    load: setLoadLabel(mark),
    e1rm: e1rmLabel(mark.e1rm),
    when: whenOf(mark.at, now),
    // Newest first, so the first row is the mark that still stands.
    standing: index === 0,
  }));
}

// One row is one SESSION: `recentDays` is keyed by session, so two workouts on one day print twice.
export function daysOf(record, now) {
  return (record.recentDays ?? []).map((day) => ({
    sessionId: day.sessionId,
    when: whenOf(day.startedAt, now),
    // Warmups are already off this wire; a drop or failure set printed bare would read as working.
    sets: day.sets
      .map((set) => (set.kind === 'working' ? setLoadLabel(set) : `${setLoadLabel(set)} ${set.kind}`))
      .join(' · '),
  }));
}

// A name is a label on a stable id, so renaming never forks a record. A row with nothing to prove is
// omitted; the alias row always stands.
export const RENAME_PROOF = 'Everything follows the name';

export function renameProofOf(record) {
  const rows = [];
  if (record.sessionCount > 0) {
    rows.push({ label: 'sessions', value: `${record.sessionCount} · unchanged` });
  }
  const marks = (record.records ?? []).length;
  if (marks > 0) {
    // `records` and `bestE1rm` are absent together on the wire.
    const best = record.bestE1rm ? ` · ${e1rmLabel(record.bestE1rm.e1rm)} kept` : '';
    rows.push({ label: 'records', value: `${countLabel(marks, 'PR', 'PRs')}${best}` });
  }
  // The names rather than the count.
  if ((record.routines ?? []).length > 0) {
    rows.push({ label: 'routines', value: record.routines.join(' · ') });
  }
  rows.push({ label: 'old name', value: 'searchable as an alias' });
  return rows;
}

// `now` is passed rather than read, so nothing here is a claim only the device's clock can support.
export function recordView(record, { now = Date.now() } = {}) {
  return {
    name: record.exercise.name,
    subhead: subheadOf(record),
    // A movement nobody has worked draws no tiles, no chart and no lists.
    logged: inTheLog(record),
    tiles: tilesOf(record, now),
    chart: chartOf(record, now),
    records: recordsOf(record, now),
    days: daysOf(record, now),
  };
}
