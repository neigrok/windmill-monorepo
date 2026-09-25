import {
  agoLabel, e1rmLabel, fmt, NO_ROUTINE, routineNameOf, ROUTINES_HREF, sessionHref, setLoadLabel, shortDayLabel,
} from './log.js';
import { weightUnit } from './units.js';

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

// The back link names the screen the record was opened from and returns there. A workout is named
// by its routine, which only the session's own read knows: without that read, or when it found no
// session, the link says `The workout`.
export function backOf(from, session = null) {
  if (from.screen === 'log') return { href: from.href ?? '#/gym/log', label: 'The log' };
  if (from.screen !== 'session') return { href: ROUTINES_HREF, label: 'Routines' };
  if (session === null) return { href: from.href ?? sessionHref(from.id), label: 'The workout' };
  return { href: from.href ?? sessionHref(from.id), label: routineNameOf(session) ?? NO_ROUTINE };
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
    records: recordsOf(record, now),
    days: daysOf(record, now),
  };
}
