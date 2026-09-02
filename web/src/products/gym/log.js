// The pure rules behind every gym surface: the URL grammar, the labels and the set grouping.

import { round } from './logger/ladder.js';
import { inDisplayUnit, LB, weightUnit } from './units.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

// `#/gym` IS the routines home; `#/gym/routines` is an alias that still resolves to it.
export const ROUTINES_HREF = '#/gym';

// The blank editor's id — a mint can never produce it, every real one being `rt_` and sixteen hex.
export const NEW_ROUTINE_ID = 'new';

export function finishIdOf(hash) {
  const match = /^#\/gym\/finish\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function finishHref(id) {
  return `#/gym/finish/${id}`;
}

export const BACKFILL_HREF = '#/gym/backfill';

// The room is Coach; `#/gym/ask/…` is the older spelling and resolves to the same screens.
export const COACH_HREF = '#/gym/coach';

export const THREADS_HREF = '#/gym/coach/threads';

export function threadIdOf(hash) {
  const match = /^#\/gym\/(?:coach|ask)\/threads\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function threadHref(id) {
  return `#/gym/coach/threads/${id}`;
}

export const NOTES_HREF = '#/gym/notes';

// The chart screen; the log's head reads the number and the reach band writes it.
export const BODYWEIGHT_HREF = '#/gym/bodyweight';

export const CONNECT_HREF = '#/gym/connect';

// The id is minted by whoever wrote the proposal, so the parse takes the whole charset the wire
// allows (`^[A-Za-z0-9_-]{8,64}$`) rather than gym's own narrower mint.
export function proposalIdOf(hash) {
  const match = /^#\/gym\/proposals\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function proposalHref(id) {
  return `#/gym/proposals/${id}`;
}

// The id is the catalog's: a slug for a seeded movement, `ex_<hex>` for one a lifter minted.
export function movementIdOf(hash) {
  const match = /^#\/gym\/movement\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function recordHref(exerciseId) {
  return `#/gym/movement/${exerciseId}`;
}

export const MOVEMENTS_HREF = '#/gym/movement';

// The token is the whole credential; the charset is the mint's — 32 bytes, base64url, unpadded.
export function sharedTokenOf(hash) {
  const match = /^#\/gym\/shared\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function sharedHref(token) {
  return `#/gym/shared/${token}`;
}

// Longest first: a routine id is also a routines URL. Anything else under #/gym is the routines
// home, which is what `#/gym` itself names.
export function screenOf(hash) {
  if (sharedTokenOf(hash)) return 'shared';
  if (sessionIdOf(hash)) return 'session';
  if (finishIdOf(hash)) return 'finish';
  if (proposalIdOf(hash)) return 'proposal';
  if (routineIdOf(hash)) return 'routine';
  if (/^#\/gym\/backfill(\/|$|\?)/.test(hash || '')) return 'backfill';
  if (threadIdOf(hash)) return 'thread';
  if (/^#\/gym\/(coach|ask)\/threads(\/|$|\?)/.test(hash || '')) return 'threads';
  if (/^#\/gym\/(coach|ask)(\/|$|\?)/.test(hash || '')) return 'coach';
  if (/^#\/gym\/notes(\/|$|\?)/.test(hash || '')) return 'notes';
  if (/^#\/gym\/connect(\/|$|\?)/.test(hash || '')) return 'connect';
  if (/^#\/gym\/(movement|stats)(\/|$|\?)/.test(hash || '')) return 'record';
  if (/^#\/gym\/log(\/|$|\?)/.test(hash || '')) return 'log';
  if (/^#\/gym\/bodyweight(\/|$|\?)/.test(hash || '')) return 'bodyweight';
  return 'routines';
}

// Never localised: a reordered locale would make the prefill card and the log row disagree.
export function dayLabel(ms) {
  const day = new Date(ms);
  return `${WEEKDAYS[day.getDay()]} ${day.getDate()} ${MONTHS[day.getMonth()]}`;
}

// `27 Jul`. Local, like every instant in this product.
export function shortDayLabel(ms) {
  const day = new Date(ms);
  return `${day.getDate()} ${MONTHS[day.getMonth()]}`;
}

export function weekdayName(ms) {
  return WEEKDAY_NAMES[new Date(ms).getDay()];
}

export function timeLabel(ms) {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

// The year is spelled here and nowhere else.
export function firstSessionLabel(ms) {
  return `first session · ${shortDayLabel(ms)} ${new Date(ms).getFullYear()}`;
}

export function whenLabel(ms) {
  return `${dayLabel(ms)} · ${timeLabel(ms)}`;
}

// Past six days a weekday alone would repeat, so `arrivedLabel` takes the date instead.
const WEEKDAY_MS = 6 * 86400000;

export function arrivedLabel(ms, now = Date.now()) {
  if (now - ms >= WEEKDAY_MS) return whenLabel(ms);
  return `${WEEKDAYS[new Date(ms).getDay()]} ${timeLabel(ms)}`;
}

// The day is the title above this line and is never printed twice.
export function sessionMetaLabel(session, setCount) {
  const started = timeLabel(session.startedAt);
  if (!isFinished(session)) return `${started}   ·   in progress   ·   ${setCountLabel(setCount)}`;
  const length = durLabel(session.finishedAt - session.startedAt);
  return `${started}–${timeLabel(session.finishedAt)}   ·   ${length}   ·   ${setCountLabel(setCount)}`;
}

// Today by its clock, anything older by its day; the calendar-day rule is agoLabel's.
export function logWhenLabel(session, now = Date.now()) {
  const when = agoLabel(session.startedAt, now) === 'today'
    ? `today · ${timeLabel(session.startedAt)}`
    : dayLabel(session.startedAt);
  if (!isFinished(session)) return `${when} · in progress`;
  return when;
}

// Calendar days, not elapsed hours: both instants fall back to their own local midnight first.
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

// Hand it an elapsed span computed from an instant, never a counter.
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

// What a form opens on with nothing better to go on — a number to be typed over.
export const EMPTY_BAR_KG = 20;
export const EMPTY_BAR_REPS = 5;

// Every printed weight in gym comes through here: display units (units.js), the ladder's rounding
// grid, and a real U+2212 minus for the band-assisted loads that sit below zero.
export function fmt(weightKg) {
  const shown = inDisplayUnit(weightKg);
  return (shown < 0 ? '−' : '') + String(Math.abs(round(shown)));
}

// The kilogram spelling, for a number that is a FIELD and not a reading: a typed value lands in the
// log as it stands, so `fmt` may never touch a value on its way to a write.
export function fmtKg(weightKg) {
  return (weightKg < 0 ? '−' : '') + String(Math.abs(round(weightKg)));
}

// Reconciles a kg field with its pound reading on the same screen. Null in kilograms.
export function alsoReadsLabel(weightKg) {
  if (weightKg == null || weightUnit() !== LB) return null;
  return `reads ${fmt(weightKg)} ${LB} in your log`;
}

export function setCountLabel(count) {
  return count === 1 ? '1 set' : `${count} sets`;
}

export function workingLabel(count) {
  return `${count} working`;
}

// `topE1rm` comes off the wire; the web computes no estimate of its own.
export function e1rmLabel(topE1rm) {
  if (topE1rm == null) return null;
  return `e1RM ${fmt(topE1rm)}`;
}

// An assisted or bodyweight set contributes zero: the sum clamps at zero rather than subtracting.
// A listed session carries the store's `tonnageKg` and no sets; one read whole is summed here.
export function tonnageOf(session, sets = null) {
  if (typeof session?.tonnageKg === 'number') return session.tonnageKg;
  if (sets == null) return null;
  return workingSetsOf(sets).reduce((total, set) => total + Math.max(set.weightKg, 0) * set.reps, 0);
}

// A zero tonnage answers null. The scale threshold is the mass and not the numeral, so both
// readings switch scale on the same week.
export function tonnageLabel(kg) {
  if (kg == null || kg <= 0) return null;
  if (kg < 1000) return `${fmt(kg)} ${weightUnit()}`;
  if (weightUnit() === LB) return `${(inDisplayUnit(kg) / 1000).toFixed(1)}k lb`;
  return `${(kg / 1000).toFixed(1)} t`;
}

// Both numbers are of what is in hand; the log carries no total.
export function loadedLine(sessions, weeks) {
  const list = sessions === 1 ? '1 session' : `${sessions} sessions`;
  const span = weeks === 1 ? '1 week' : `${weeks} weeks`;
  return `${list} · ${span} loaded`;
}

// A fold over the page in hand: the log arrives newest-first, so a week is a run of adjacent rows.
// Weeks start Monday in the lifter's own zone, and the oldest loaded week reports no tonnage while
// `Load older` can still add sessions to it.
export function weeksOf(summaries, { complete = false } = {}) {
  const weeks = [];
  for (const summary of summaries) {
    // The arithmetic runs at noon and the Monday is rebuilt from the date it lands on: a zone whose
    // clocks jump at local midnight has no 00:00 that day, and the instant is this fold's key.
    const day = new Date(summary.startedAt);
    day.setHours(12, 0, 0, 0);
    day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
    const monday = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const startedAt = monday.getTime();
    const open = weeks[weeks.length - 1];
    if (open && open.startedAt === startedAt) {
      open.sessions.push(summary);
      continue;
    }
    weeks.push({
      startedAt,
      label: `week of ${monday.getDate()} ${MONTHS[monday.getMonth()].toLowerCase()}`,
      sessions: [summary],
    });
  }
  return weeks.map((week, index) => {
    const partial = index === weeks.length - 1 && !complete;
    // A row carrying no `tonnageKg` leaves the week unsummable; summing the rest would understate it.
    const unknown = week.sessions.some((session) => typeof session.tonnageKg !== 'number');
    if (partial || unknown) return { ...week, tonnage: null };
    const kg = week.sessions.reduce((total, session) => total + session.tonnageKg, 0);
    return { ...week, tonnage: tonnageLabel(kg) };
  });
}

// Saved on this device only. Not a wire field: each surface decides it from the queue it holds, and
// the web holds nothing locally.
export function onThisDevice(session) {
  return session?.onThisDevice === true;
}

// The store decides which sessions hold a PR; nothing here re-derives one. It is judged against the
// log as it is now, so a correction moves records and the log is re-read when one lands.
export function hasRecord(session) {
  return session?.record === true;
}

// `lastTrainedAt` is the store's aggregate over the log; its absence IS this state.
export const UNTESTED = 'untested';

export function isUntested(routine) {
  return routine?.lastTrainedAt == null;
}

export function routineMetaLabel(routine, now = Date.now()) {
  const count = routine.entries?.length ?? 0;
  const movements = count === 1 ? '1 movement' : `${count} movements`;
  if (isUntested(routine)) return `${movements} · ${UNTESTED}`;
  return `${movements} · trained ${agoLabel(routine.lastTrainedAt, now)}`;
}

// "No target" has two spellings on the wire: the field omitted, and a zero. Zero is the absence of a
// load, never a load; a band-assisted −20 IS a target.
export function targetLoadOf(weightKg) {
  if (weightKg == null || weightKg === 0) return null;
  return round(weightKg);
}

// An entry with no `targetSets` is open. The absence is the whole state — no flag and no zero — and
// the wire refuses an open line that still names reps or a weight.
export const OPEN_TARGET = 'open';

// An absent weight prints nothing; an absent rep target prints `max`.
export function entryLabel(entry) {
  if (entry.targetSets == null) return OPEN_TARGET;
  const reps = entry.targetReps ?? 'max';
  const target = targetLoadOf(entry.targetWeightKg);
  if (target == null) return `${entry.targetSets} × ${reps}`;
  return `${entry.targetSets} × ${reps} · ${fmt(target)}`;
}

// Only a `working` set counts toward a target, a record or a count; the kinds are warmup · working ·
// drop · failure.
export function workingSetsOf(sets, exerciseId = null) {
  return sets.filter((set) => (
    set.kind === 'working' && (exerciseId == null || set.exerciseId === exerciseId)
  ));
}

// The heaviest working set, ties going to more reps at the same load. A listed session carries the
// store's `topSet` and no sets; one read whole is picked here. Both answer {weightKg, reps} or null.
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

export function movementOf(catalog, exerciseId) {
  return catalog?.find((exercise) => exercise.id === exerciseId) ?? null;
}

export function nameOfMovement(catalog, exerciseId) {
  return movementOf(catalog, exerciseId)?.name ?? exerciseId;
}

// A character is a CODE POINT, here and on the phones: that is the unit Postgres `char_length`
// counts, and sixty of them weigh at most 240 bytes — the store's own ceiling (`kMaxNameLength`),
// which a name this field accepts can therefore never break.
export const NAME_MAX = 60;

// The counter is chrome a short name does not need: it is drawn from the last fifth of the bound,
// the same rule the note editor's byte counter reads (notes/notes.js).
export const NAME_COUNT_FROM = 48;

// Never `.length`: that counts UTF-16 units, and one emoji is one character weighing two of them.
export function nameChars(typed) {
  return [...(typed ?? '')].length;
}

// The cut, in the unit the counter counts, and never through the middle of a character. Applied
// where a name is typed, never to one that arrived from the store.
export function cappedName(typed, max = NAME_MAX) {
  return [...(typed ?? '')].slice(0, max).join('');
}

export function showsNameCount(typed) {
  return nameChars(typed) >= NAME_COUNT_FROM;
}

export function nameCountLabel(typed) {
  return `${nameChars(typed)}/${NAME_MAX}`;
}

// A stored name can open a field already over the cap; the cut on the way in only stops a key and a paste.
export function isNameOverCap(typed) {
  return nameChars(typed) > NAME_MAX;
}

// Zero is an instant like any other, so this asks for absence and not truthiness.
export function isFinished(session) {
  return session.finishedAt != null;
}

export function isFirstSession(sessions, id) {
  return !sessions.some((session) => session.id !== id && isFinished(session));
}

// The four-hour close stamps the end at the last set, or at the start when there was none; a Finish
// is stamped after the set it follows. A listed session carries the store's `closedItself`.
export const CLOSED_ITSELF_NOTE = 'closed on its own — no set for four hours';

export function closedOnItsOwn(session, sets = null) {
  if (typeof session?.closedItself === 'boolean') return session.closedItself;
  if (!isFinished(session)) return false;
  if (sets == null) return false;
  if (sets.length === 0) return session.finishedAt === session.startedAt;
  return session.finishedAt === Math.max(...sets.map((set) => set.completedAt));
}

// The snapshot frozen at session start. The wire may carry it parsed or as the stored json string.
export function planOf(session) {
  const plan = session?.plan;
  if (!plan) return null;
  if (typeof plan !== 'string') return plan;
  try { return JSON.parse(plan); } catch { return null; }
}

// The routine is the title above this line and is never printed twice.
export function sessionDetailMeta(session, sets) {
  const parts = [dayLabel(session.startedAt)];
  if (isFinished(session)) parts.push(durLabel(session.finishedAt - session.startedAt));
  else parts.push('in progress');
  parts.push(workingLabel(workingSetsOf(sets).length));
  const tonnage = tonnageLabel(tonnageOf(session, sets));
  if (tonnage) parts.push(tonnage);
  return parts.join(' · ');
}

// The instant is the session's start, which is when the plan was frozen.
export function planFrozenLabel(session) {
  if (!planOf(session)) return null;
  return `plan snapshot · frozen ${timeLabel(session.startedAt)}`;
}

// The rest target in force for a movement, and where it came from: the routine entry's own
// `restSeconds` when the frozen plan names one for this movement alone, the dial otherwise. Null when
// neither names one. `fromRoutine` is the fact the timer says once, on every surface.
export function restInForce(session, exerciseId, dialSeconds) {
  const entry = planReadingOf(session, exerciseId).entry;
  if (entry?.restSeconds != null) return { seconds: entry.restSeconds, fromRoutine: true };
  if (dialSeconds == null) return null;
  return { seconds: dialSeconds, fromRoutine: false };
}

export const FROM_THE_ROUTINE = ' · from the routine';

export const NOT_IN_PLAN = 'not in the plan';

// Read off the frozen snapshot, never off today's routine. A snapshot entry names its fields
// `sets` · `reps` · `weightKg` where a routine entry names them `target…`.
// A plan may name one movement twice and a `PlanEntry` carries no id, so nothing can tell which a
// logged set was performed against; that case answers `ambiguous`.
export function planReadingOf(session, exerciseId) {
  // The snapshot is frozen jsonb echoed back verbatim, so a list of entries is only a convention.
  // An unreadable plan draws no comparison; an empty list means every movement was added today.
  const plan = planOf(session);
  if (!plan || !Array.isArray(plan.entries)) return { kind: 'unplanned', line: null, entry: null };
  const entries = plan.entries.filter((entry) => entry?.exerciseId === exerciseId);
  if (entries.length === 0) return { kind: 'added', line: NOT_IN_PLAN, entry: null };
  if (entries.length > 1) return { kind: 'ambiguous', line: null, entry: null };
  const entry = entries[0];
  const line = entryLabel({
    targetSets: entry.sets, targetReps: entry.reps, targetWeightKg: entry.weightKg,
  });
  return { kind: 'planned', line: `plan ${line}`, entry };
}

// Spelled out to ten; past ten the numeral is what is left.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

export function numberWord(count) {
  return NUMBER_WORDS[count] ?? String(count);
}

// A set that is not `working` says only its own kind and is measured against no target.
// Short only when the bar did not go up: heavier for fewer reps is not short.
export function setNoteOf(set, reading, first) {
  if (set.kind !== 'working') return set.kind;
  if (reading.kind === 'added') return first ? 'added today' : null;
  if (reading.kind !== 'planned') return null;
  const { reps, weightKg } = reading.entry;
  // A plan that named no weight can be neither gone over nor met.
  const target = targetLoadOf(weightKg);
  const load = round(set.weightKg);
  if (reps != null && set.reps < reps && (target == null || load <= target)) {
    return `${numberWord(reps - set.reps)} short`;
  }
  if (target == null) return null;
  if (load > target) return `+${fmt(load - target)} over plan`;
  if (load === target) return 'on plan';
  return null;
}

// Zero is the absence of a load: the movement done at bodyweight. A band-assisted −20 prints itself.
export function setLoadLabel(set) {
  if (set.weightKg === 0) return `bodyweight × ${set.reps}`;
  return `${fmt(set.weightKg)} × ${set.reps}`;
}

export const NO_ROUTINE = 'Free session';

export function routineNameOf(session) {
  // The snapshot is frozen jsonb echoed back verbatim: a non-string is no routine.
  const routine = planOf(session)?.routine;
  return typeof routine === 'string' && routine !== '' ? routine : null;
}

// First-performed order falls out of Map insertion order over sets sorted by completion; inside an
// exercise the server-assigned number orders them, and an unnumbered set sorts last so the
// comparator never returns NaN.
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
