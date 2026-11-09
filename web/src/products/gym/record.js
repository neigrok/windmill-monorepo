import { t } from './i18n/index.js';
import {
  agoLabel, daysAgo, e1rmLabel, fmt, NO_ROUTINE, routineNameOf, ROUTINES_HREF, sessionHref, setLoadLabel, shortDayLabel,
} from './log.js';
import { weightUnit } from './units.js';

export const NEVER_LOGGED = t('gym.record.neverLogged');
export const NEVER_LOGGED_LINE = t('gym.record.neverLoggedLine');

// 'today' and 'yesterday' by name, every other day by its date.
export function whenOf(ms, now) {
  if (daysAgo(ms, now) <= 1) return agoLabel(ms, now);
  return shortDayLabel(ms);
}

export function subheadOf(record) {
  const equipment = t('gym.record.equipment', { equipment: String(record.exercise.equipment) });
  const routines = record.routineCount === 0
    ? t('gym.record.inNoRoutine')
    : t('gym.record.inRoutines', { count: record.routineCount });
  // 'never logged' rather than '0 sessions'.
  const sessions = record.sessionCount > 0 ? t('gym.log.sessionCount', { count: record.sessionCount }) : t('gym.record.neverLoggedShort');
  return `${equipment} · ${routines} · ${sessions}`;
}

// Either tile may be absent.
export function tilesOf(record, now) {
  const tiles = [];
  if (record.bestE1rm) {
    tiles.push({
      label: t('gym.record.bestE1rm'),
      value: fmt(record.bestE1rm.e1rm),
      sub: `${whenOf(record.bestE1rm.at, now)} · ${setLoadLabel(record.bestE1rm)}`,
      standing: true,
    });
  }
  if (record.heaviest) {
    // At zero added load, the bodyweight movement's comparison reads its reps.
    const { weightKg, reps } = record.heaviest;
    tiles.push(weightKg === 0
      ? { label: t('gym.record.heaviest'), value: String(reps), sub: t('gym.record.repsBodyweight'), standing: false }
      : { label: t('gym.record.heaviest'), value: fmt(weightKg), sub: t('gym.record.forReps', { unit: weightUnit(), reps: String(reps) }), standing: false });
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
    sets: day.sets.map((set) => setLoadLabel(set)).join(' · '),
  }));
}

// The back link names the screen the record was opened from and returns there. A workout is named
// by its routine, which only the session's own read knows: without that read, or when it found no
// session, the link says `The workout`.
export function backOf(from, session = null) {
  if (from.screen === 'log') return { href: from.href ?? '#/gym/log', label: t('gym.log.title') };
  if (from.screen !== 'session') return { href: ROUTINES_HREF, label: t('gym.record.routines') };
  if (session === null) return { href: from.href ?? sessionHref(from.id), label: t('gym.record.theWorkout') };
  return { href: from.href ?? sessionHref(from.id), label: routineNameOf(session) ?? NO_ROUTINE };
}

// A name is a label on a stable id, so renaming never forks a record. A row with nothing to prove is
// omitted; the alias row always stands.
export const RENAME_PROOF = t('gym.record.renameProof');

export function renameProofOf(record) {
  const rows = [];
  if (record.sessionCount > 0) {
    rows.push({ label: t('gym.record.proofSessions'), value: t('gym.record.sessionsUnchanged', { count: record.sessionCount }) });
  }
  const marks = (record.records ?? []).length;
  if (marks > 0) {
    // `records` and `bestE1rm` are absent together on the wire.
    const value = record.bestE1rm
      ? t('gym.record.prCountKept', { count: marks, e1rm: e1rmLabel(record.bestE1rm.e1rm) })
      : t('gym.record.prCount', { count: marks });
    rows.push({ label: t('gym.record.proofRecords'), value });
  }
  // The names rather than the count.
  if ((record.routines ?? []).length > 0) {
    rows.push({ label: t('gym.record.proofRoutines'), value: record.routines.join(' · ') });
  }
  rows.push({ label: t('gym.record.proofOldName'), value: t('gym.record.alias') });
  return rows;
}

// `now` is passed rather than read, so nothing here is a claim only the device's clock can support.
export function recordView(record, { now = Date.now() } = {}) {
  return {
    name: record.exercise.name,
    subhead: subheadOf(record),
    // A movement nobody has worked draws no tiles, no chart and no lists.
    logged: record.sessionCount > 0,
    tiles: tilesOf(record, now),
    records: recordsOf(record, now),
    days: daysOf(record, now),
  };
}
