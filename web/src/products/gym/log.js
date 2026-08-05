// How a training log reads — the pure rules behind every gym surface, with no React and no fetch
// in them: which room a URL names and how each of those URLs is written, every label a number is
// printed under, and the first-performed order a session's sets are grouped in. The logger, the log
// list, the routines and the session detail all read from here, so there is exactly one way a
// weight, a day and a duration are spelled in this product; the tests read the same rules without a
// browser.

import { round } from './logger/ladder.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A position is a URL: #/gym is today, #/gym/log the log, #/gym/routines the routines,
// #/gym/routines/rt_… one routine's editor, #/gym/session/ses_… one session,
// #/gym/finish/ses_… the end of the one just closed, #/gym/backfill the past-workout form.
// Reading and writing that one grammar live together, so a link and the parse that answers it can
// never drift — the logger writes it to walk into the session it just started.
export function sessionIdOf(hash) {
  const match = /^#\/gym\/session\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function sessionHref(id) {
  return `#/gym/session/${id}`;
}

export function routineIdOf(hash) {
  const match = /^#\/gym\/routines\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function routineHref(id) {
  return `#/gym/routines/${id}`;
}

export const ROUTINES_HREF = '#/gym/routines';

// A routine being written for the first time stands at the same URL as one being edited, under the
// one id a mint can never produce — every real one is `rt_` and sixteen hex. So a reload lands back
// on the blank editor instead of a 404 for a routine nobody has saved yet, and the editor keeps one
// draft path for both.
export const NEW_ROUTINE_ID = 'new';

// The end of a session is a place, not a moment: the screen re-reads what the store computed, so a
// reload, a back button and a link from the log all show the same three facts.
export function finishIdOf(hash) {
  const match = /^#\/gym\/finish\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function finishHref(id) {
  return `#/gym/finish/${id}`;
}

export const BACKFILL_HREF = '#/gym/backfill';

// The editor is read before the list it sits under, because a routine id is also a routines URL and
// only the longer of the two is that one routine. Anything else under #/gym is Today: a hash this
// build does not know is a link from a build that did, and the home screen is where a lifter can
// get anywhere from.
export function screenOf(hash) {
  if (sessionIdOf(hash)) return 'session';
  if (finishIdOf(hash)) return 'finish';
  if (routineIdOf(hash)) return 'routine';
  if (/^#\/gym\/routines(\/|$|\?)/.test(hash || '')) return 'routines';
  if (/^#\/gym\/backfill(\/|$|\?)/.test(hash || '')) return 'backfill';
  if (/^#\/gym\/log(\/|$|\?)/.test(hash || '')) return 'log';
  return 'today';
}

// Spelled out rather than localised: 'Tue 22 Jul' is the string the design draws, and a locale
// that reorders it would make the prefill card and the log row disagree about the same day.
export function dayLabel(ms) {
  const day = new Date(ms);
  return `${WEEKDAYS[day.getDay()]} ${day.getDate()} ${MONTHS[day.getMonth()]}`;
}

// The day a session happened, spelled the way a lifter names the day they train on. It is the
// opening value in the name field at the finish, never a name anything writes on its own: the field
// is on screen, it is typed over, and no routine exists until Save is tapped.
export function weekdayName(ms) {
  return WEEKDAY_NAMES[new Date(ms).getDay()];
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

// "Yesterday" is a claim about the calendar, not about elapsed hours: a session finished at 07:00
// is still today at 21:00, and one finished at 23:00 is already yesterday by 01:00. So both
// instants fall back to their own local midnight before the difference is taken — which also makes
// the count right across a 23- and a 25-hour day, where dividing by 86400000 is not.
export function agoLabel(ms, now = Date.now()) {
  const midnight = (at) => {
    const day = new Date(at);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
  };
  const days = Math.round((midnight(now) - midnight(ms)) / 86400000);
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

// A routine row says what it holds and when it was last used, because that is how a lifter picks
// one — and it is the same fact the list is sorted by, so the row never has to explain its own
// order. A routine nobody has trained yet says exactly that rather than borrowing today.
export function routineMetaLabel(routine, now = Date.now()) {
  const count = routine.entries?.length ?? 0;
  const movements = count === 1 ? '1 exercise' : `${count} exercises`;
  if (routine.lastTrainedAt == null) return `${movements} · never trained`;
  return `${movements} · trained ${agoLabel(routine.lastTrainedAt, now)}`;
}

// What a routine asks a movement for, in one line: the editor's row, Today's preview of the routine
// due next, and the finish screen's offer all print it, so a target reads the same wherever it is
// read. An absent weight is "whatever you did last time" and prints nothing rather than a zero —
// and neither does an actual zero, because zero is not a load but the absence of one, so a chin-up
// reads `3 × 8` while a band-assisted −20 prints, being a real point on this number line.
//
// An absent REP target is canon screen 6's `3 × max` — a movement taken to whatever it gives that
// day. It is not a zero and it is not a blank, and the wire spells it by omission (gymApi.js).
export function entryLabel(entry) {
  const reps = entry.targetReps ?? 'max';
  const weight = entry.targetWeightKg;
  if (weight == null || weight === 0) return `${entry.targetSets} × ${reps}`;
  return `${entry.targetSets} × ${reps} · ${fmt(weight)}`;
}

// A movement's line in the session list, which is also where the next one gets appended between
// sets. A movement with no sets is the normal state of one just added — it is not an empty slot to
// apologise for, so it says what makes it start rather than counting to zero.
export function sessionMovementMeta({ done, planned = null }) {
  if (done === 0) return 'no sets yet — logging one starts it';
  if (planned) return `${done} of ${planned} sets`;
  return setCountLabel(done);
}

// ONE WORD FOR WHAT COUNTS. A set counts toward a target, a plan counter, a record and the number
// under the thumb only when its kind is `working` — the kinds are warmup · working · drop · failure,
// and the last three are all things that happened to a set the plan never asked for. The domain's
// record rules read the same word, so a drop must not advance "set 4 of 5" here while counting
// toward nothing there. The movement is optional because a session's sets are sometimes already
// one movement's.
export function workingSetsOf(sets, exerciseId = null) {
  return sets.filter((set) => (
    set.kind === 'working' && (exerciseId == null || set.exerciseId === exerciseId)
  ));
}

// The heaviest WORKING set of a session — the column G8 draws beside a log row, and what a
// movement's line is measured on everywhere else in this product: never volume, because four light
// sets must not beat three heavy ones. A tie goes to the set that got more reps at the same load.
//
// Two sources, one rule. A session in the LIST carries the store's own pick under `topSet`
// (gymApi.js), because the list carries no sets; a session read whole carries the sets and the pick
// is made here. Both answer `{weightKg, reps}` or nothing at all.
export function topSetOf(session, sets = null) {
  if (session?.topSet) return session.topSet;
  if (sets == null) return null;
  const working = workingSetsOf(sets);
  if (working.length === 0) return null;
  return working.reduce((best, set) => {
    if (set.weightKg > best.weightKg) return set;
    if (set.weightKg === best.weightKg && set.reps > best.reps) return set;
    return best;
  });
}

export function topSetLabel(top) {
  if (!top) return '—';
  return `${fmt(top.weightKg)} × ${top.reps}`;
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

// "Your first session" is the log's claim and never the review's: the store answers what happened
// inside one session and cannot see the list. One other FINISHED session is all it takes to refute
// it, and the log reads newest first — so the two newest rows settle it, and the session being asked
// about is excluded because it is one of them.
export function isFirstSession(sessions, id) {
  return !sessions.some((session) => session.id !== id && isFinished(session));
}

// A session nobody ended. The four-hour close stamps the end AT the last set — and at the start
// instant when there was never one (backend §3.2) — while a Finish is stamped at the tap, which
// happens after the set it follows and after a round trip. So an end that is not later than the
// last thing that happened is an end nobody pressed, and that is the whole of the fingerprint.
//
// Two sources, one rule, exactly as the top set has. A session in the LIST carries the store's own
// answer under `closedItself`, which is that same fingerprint read where the sets are; a session
// read whole carries the sets and the fingerprint is read here.
export const CLOSED_ITSELF_NOTE = 'closed on its own — no set for four hours';

export function closedOnItsOwn(session, sets = null) {
  if (typeof session?.closedItself === 'boolean') return session.closedItself;
  if (!isFinished(session)) return false;
  if (sets == null) return false;
  if (sets.length === 0) return session.finishedAt === session.startedAt;
  return session.finishedAt === Math.max(...sets.map((set) => set.completedAt));
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

// ONE WORD FOR A SESSION NOBODY PLANNED, everywhere it is named: the log row, the session read
// whole, the finish subtitle, the overlap panel and the logger's own bar. It reads one step quieter
// than a routine name and never as a fault — most rows in most logs will not have one — and it is
// the word G8 and canon screen 2 both use, which is why the logger stopped calling the same session
// "Ad-hoc".
export const NO_ROUTINE = 'No routine';

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
