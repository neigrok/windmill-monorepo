// How a training log reads — the pure rules behind every gym surface, with no React and no fetch
// in them: which session a URL names and how that URL is written, every label a number is printed
// under, and the first-performed order a session's sets are grouped in. The logger, the log list
// and the session detail all read from here, so there is exactly one way a weight, a day and a
// duration are spelled in this product; the tests read the same rules without a browser.

import { round } from './logger/ladder.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A position is a URL: #/gym is today, #/gym/log the log, #/gym/session/ses_… one session.
// Reading and writing that one grammar live together, so a link and the parse that answers it can
// never drift — the logger writes it to walk into the session it just started.
export function sessionIdOf(hash) {
  const match = /^#\/gym\/session\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function sessionHref(id) {
  return `#/gym/session/${id}`;
}

export function screenOf(hash) {
  if (sessionIdOf(hash)) return 'session';
  if (/^#\/gym\/log(\/|$|\?)/.test(hash || '')) return 'log';
  return 'today';
}

// Spelled out rather than localised: 'Tue 22 Jul' is the string the design draws, and a locale
// that reorders it would make the prefill card and the log row disagree about the same day.
export function dayLabel(ms) {
  const day = new Date(ms);
  return `${WEEKDAYS[day.getDay()]} ${day.getDate()} ${MONTHS[day.getMonth()]}`;
}

export function timeLabel(ms) {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

export function whenLabel(ms) {
  return `${dayLabel(ms)} · ${timeLabel(ms)}`;
}

// A session read whole says when it ran, how long it took and how much is in it — the day itself
// is the title above this line, so it is never printed twice. An open session gets no end time
// invented for it.
export function sessionMetaLabel(session, setCount) {
  const started = timeLabel(session.startedAt);
  if (!isFinished(session)) return `${started}   ·   in progress   ·   ${setCountLabel(setCount)}`;
  const length = durLabel(session.finishedAt - session.startedAt);
  return `${started}–${timeLabel(session.finishedAt)}   ·   ${length}   ·   ${setCountLabel(setCount)}`;
}

export function agoLabel(ms, now = Date.now()) {
  const days = Math.round((now - ms) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

// The session clock and the rest timer both read this, and both hand it an elapsed span computed
// from an instant — never a counter they incremented. A backgrounded tab, a locked phone and a
// full reload therefore all come back showing the true elapsed time.
export function clockOf(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const head = hours ? `${hours}:${String(minutes).padStart(2, '0')}` : String(minutes);
  return `${head}:${String(seconds).padStart(2, '0')}`;
}

export function durLabel(ms) {
  const minutes = Math.max(1, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// Weights print with trailing zeros stripped and a real U+2212 minus, because a negative load is
// a normal point on the number line here — band-assisted work sits below zero.
// The grid is the ladder's, not a second opinion: this read the magnitude to two decimals itself
// until the two spellings disagreed on a negative half-cent, and one of them has a golden.
export function fmt(weight) {
  return (weight < 0 ? '−' : '') + String(Math.abs(round(weight)));
}

export function setCountLabel(count) {
  return count === 1 ? '1 set' : `${count} sets`;
}

// A movement is a stable id everywhere except on screen, where it is the catalog's display name.
// Falling back to the id keeps a sentence readable when the catalog hasn't answered yet — a slug
// a lifter can still recognise beats a blank where the movement should be.
export function nameOfMovement(catalog, exerciseId) {
  return catalog?.find((exercise) => exercise.id === exerciseId)?.name ?? exerciseId;
}

// A session is over when the server says it has an end instant — and only then. Zero is an
// instant like any other, so this asks for absence rather than truthiness.
export function isFinished(session) {
  return session.finishedAt != null;
}

// The plan is the snapshot frozen at session start — a session from two weeks ago still reads
// against the target it actually had. The wire may carry it already parsed or as the stored json
// string, and both mean the same thing, so every surface asks this one question rather than
// re-deciding what a plan looks like.
export function planOf(session) {
  const plan = session?.plan;
  if (!plan) return null;
  if (typeof plan !== 'string') return plan;
  try { return JSON.parse(plan); } catch { return null; }
}

export function routineNameOf(session) {
  // The snapshot is frozen jsonb the server echoes back verbatim, so `routine` is only a name by
  // convention — anything else React would throw on as a child. A non-string is no routine.
  const routine = planOf(session)?.routine;
  return typeof routine === 'string' && routine !== '' ? routine : null;
}

// First-performed order falls out of Map insertion order over sets sorted by completion; inside an
// exercise the server-assigned number is the order. A set the server has not numbered yet is one
// the logger is still flushing — it is the newest thing in that exercise, so it sorts last, and
// two of them fall back to when they happened. Without that floor the comparator returns NaN and
// the order of a session being logged is whatever the sort implementation happens to do.
export function groupByExercise(sets) {
  const groups = new Map();
  for (const set of [...sets].sort((a, b) => a.completedAt - b.completedAt)) {
    if (!groups.has(set.exerciseId)) groups.set(set.exerciseId, []);
    groups.get(set.exerciseId).push(set);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const left = a.setNumber ?? Number.MAX_SAFE_INTEGER;
      const right = b.setNumber ?? Number.MAX_SAFE_INTEGER;
      if (left !== right) return left - right;
      return a.completedAt - b.completedAt;
    });
  }
  return [...groups.entries()];
}
