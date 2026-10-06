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

export function fixSetIdOf(hash) {
  return /^#\/gym\/session\/[A-Za-z0-9_-]+\/set\/([A-Za-z0-9_-]+)\/edit(?:\?|$)/.exec(hash || '')?.[1] ?? null;
}

export function fixSetHref(sessionId, setId, from = '#/gym/log') {
  return `${sessionHref(sessionId)}/set/${setId}/edit?from=${encodeURIComponent(from)}`;
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

// `#/gym/backfill` is the routine pick; a routine's id opens its filled form, `free` the empty one.
export const BACKFILL_HREF = '#/gym/backfill';

export const FREE_SESSION = 'free';

// A form opened from a routine's ⋯ carries that origin in its own hash, so its back link returns to
// Routines; one with no origin was opened from the pick.
export const FROM_PICK = 'pick';
export const FROM_ROUTINE_MENU = 'routines';

export function backfillHref(routineId, from = FROM_PICK) {
  if (from === FROM_ROUTINE_MENU) return `${BACKFILL_HREF}/${routineId}?from=${FROM_ROUTINE_MENU}`;
  return `${BACKFILL_HREF}/${routineId}`;
}

export function backfillTargetOf(hash) {
  const match = /^#\/gym\/backfill\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function backfillFromOf(hash) {
  return /^#\/gym\/backfill\/[A-Za-z0-9_-]+\?from=routines$/.test(hash || '') ? FROM_ROUTINE_MENU : FROM_PICK;
}

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

// A record opened from a workout carries that session in its own hash, so its back link returns
// there. A record opened with no origin was opened from Routines, the home.
export const FROM_ROUTINES = { screen: 'routines' };

export function fromSession(sessionId, href) {
  return { screen: 'session', id: sessionId, ...(href ? { href } : {}) };
}

export function recordHref(exerciseId, from = FROM_ROUTINES) {
  if (from.screen === 'session') return `#/gym/movement/${exerciseId}?from=session.${from.id}${from.href ? `&return=${encodeURIComponent(from.href)}` : ''}`;
  if (from.screen === 'log') return `#/gym/movement/${exerciseId}?from=${encodeURIComponent(from.href ?? 'log')}`;
  return `#/gym/movement/${exerciseId}`;
}

export function recordFromOf(hash) {
  const query = new URLSearchParams((hash ?? '').split('?').slice(1).join('?'));
  const origin = query.get('from');
  if (origin === 'log' || /^#\/gym\/log(?:\?|$)/.test(origin ?? '')) return { screen: 'log', ...(origin === 'log' ? {} : { href: origin }) };
  const match = /^session\.([A-Za-z0-9_-]+)$/.exec(origin ?? '');
  if (!match) return FROM_ROUTINES;
  const target = query.get('return');
  return fromSession(match[1], /^#\/gym\/session\/[A-Za-z0-9_-]+(?:\?|$)/.test(target ?? '') ? target : undefined);
}

export const MOVEMENTS_HREF = '#/gym/movement';

// The token is the whole credential; the charset is the mint's — 32 bytes, base64url, unpadded.
export function sharedTokenOf(hash) {
  const match = /^#\/gym\/shared\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function sharedLogTokenOf(hash) {
  const match = /^#\/gym\/shared-log\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function sharedHref(token) {
  return `#/gym/shared/${token}`;
}

// Longest first: a routine id is also a routines URL. Anything else under #/gym is the routines
// home, which is what `#/gym` itself names.
export function screenOf(hash) {
  if (sharedLogTokenOf(hash)) return 'shared-log';
  if (sharedTokenOf(hash)) return 'shared';
  if (/^#\/gym\/share-log(?:[/?]|$)/.test(hash || '')) return 'share-log';
  if (sessionIdOf(hash)) return 'session';
  if (finishIdOf(hash)) return 'finish';
  if (proposalIdOf(hash)) return 'proposal';
  if (routineIdOf(hash)) return 'routine';
  if (/^#\/gym\/backfill(\/|$|\?)/.test(hash || '')) return 'backfill';
  if (threadIdOf(hash)) return 'thread';
  if (/^#\/gym\/(coach|ask)\/threads(\/|$|\?)/.test(hash || '')) return 'threads';
  if (/^#\/gym\/(coach|ask)(\/|$|\?)/.test(hash || '')) return 'coach';
  if (/^#\/gym\/notes(\/|$|\?)/.test(hash || '')) return 'notes';
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

export function whenLabel(ms) {
  return `${dayLabel(ms)} · ${timeLabel(ms)}`;
}

// Past six days a weekday alone would repeat, so `arrivedLabel` takes the date instead.
const WEEKDAY_MS = 6 * 86400000;

export function arrivedLabel(ms, now = Date.now()) {
  if (now - ms >= WEEKDAY_MS) return whenLabel(ms);
  return `${WEEKDAYS[new Date(ms).getDay()]} ${timeLabel(ms)}`;
}

// The routine is the title above this line, so the day leads it.
export function sessionMetaLabel(session, setCount) {
  const day = dayLabel(session.startedAt);
  const started = timeLabel(session.startedAt);
  if (!isFinished(session)) return `${day}   ·   ${started}   ·   in progress   ·   ${setCountLabel(setCount)}`;
  const length = durLabel(session.finishedAt - session.startedAt);
  return `${day}   ·   ${started}–${timeLabel(session.finishedAt)}   ·   ${length}   ·   ${setCountLabel(setCount)}`;
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

export function workoutClocks(session, sets, now) {
  const end = session.finishedAt ?? now;
  const latest = sets.length ? Math.max(...sets.map((set) => set.completedAt)) : session.startedAt;
  return [
    { label: 'Workout time', anchor: session.startedAt },
    { label: sets.length ? 'Since last set' : 'Since start', anchor: latest },
  ].map(({ label, anchor }) => {
    const elapsed = Math.max(0, end - anchor);
    const total = Math.floor(elapsed / 1000);
    const parts = [[Math.floor(total / 3600), 'hour'], [Math.floor(total % 3600 / 60), 'minute'], [total % 60, 'second']];
    const spoken = parts.filter(([count]) => count > 0).map(([count, unit]) => `${count} ${unit}${count === 1 ? '' : 's'}`).join(' ') || '0 seconds';
    return { label, elapsed, spoken };
  });
}

export function durLabel(ms) {
  const minutes = Math.max(1, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// Every printed weight in gym comes through here: display units (units.js), the ladder's rounding
// grid, and a real U+2212 minus for the band-assisted loads that sit below zero.
export function fmt(weightKg, unit = weightUnit()) {
  const shown = inDisplayUnit(weightKg, unit);
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

// `topE1rm` comes off the wire; the web computes no estimate of its own.
export function e1rmLabel(topE1rm) {
  if (topE1rm == null) return null;
  return `e1RM ${fmt(topE1rm)}`;
}

// A tonnage is a bare number in the account's unit, grouped by thousands — `1,380`. The unit is
// named once per surface (the log's head says `loads in kg`), never on a row. Nothing, a zero, or a
// number that is not finite answers null, and nothing is drawn.
// Grouped in one fixed spelling and never localised, like every date in this product.
const TONNAGE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export function tonnageLabel(kg, unit = weightUnit()) {
  if (!Number.isFinite(kg) || kg <= 0) return null;
  return TONNAGE.format(inDisplayUnit(kg, unit));
}

// `lastTrainedAt` is the store's aggregate over the log; its absence IS this state.
export const NEVER_TRAINED_ALONE = 'Never trained';

export function isNeverTrained(routine) {
  return routine?.lastTrainedAt == null;
}

function movementsLabel(routine) {
  const count = routine.entries?.length ?? 0;
  return count === 1 ? '1 movement' : `${count} movements`;
}

// `4 movements · 10 sets`, the sets the routine names; an open entry names none.
export function routineSizeLabel(routine) {
  const sets = (routine.entries ?? []).reduce((count, entry) => count + (entry.sets?.length ?? 0), 0);
  if (sets === 0) return movementsLabel(routine);
  return `${movementsLabel(routine)} · ${setCountLabel(sets)}`;
}

// The day a routine was last trained, `22 Sep`, or that it never was.
export function lastTrainedDayLabel(routine) {
  if (isNeverTrained(routine)) return NEVER_TRAINED_ALONE;
  return shortDayLabel(routine.lastTrainedAt);
}

// "No target" has two spellings on the wire: the field omitted, and a zero. Zero is the absence of a
// load, never a load; a band-assisted −20 IS a target.
export function targetLoadOf(weightKg) {
  if (weightKg == null || weightKg === 0) return null;
  return round(weightKg);
}

// An entry with no `sets` is open. The absence is the whole state — no flag and no zero — and an
// empty list is refused by the store like a zero target.
export const OPEN_TARGET = 'open';

const roundedLoad = (set) => (set.weightKg == null ? null : round(set.weightKg));

// Two sets agree element-wise after the ladder's rounding of each load (R5); an absent load and a
// zero are different answers here, since zero is what was sent.
export function sameSet(left, right) {
  return (left.reps ?? null) === (right.reps ?? null) && roundedLoad(left) === roundedLoad(right);
}

// A straight scheme: every set agrees with the first. One set agrees with itself.
export function schemeAgrees(sets) {
  return sets.every((set) => sameSet(set, sets[0]));
}

// ONE set's vocabulary on every surface — the logged pill's own shape — with the nulls printed as
// their placeholders: `100 × max`, `last × 5`.
export function setReading(set) {
  const load = targetLoadOf(set.weightKg);
  return `${load == null ? 'last' : fmt(load)} × ${set.reps ?? 'max'}`;
}

// A scheme's vocabulary, whatever its size: `{n} × {reps} · {load}`, a column whose sets disagree
// printing its range `lo–hi` — a placeholder standing as the top: `max` of a reps column, `last` of a
// load column —
// and a load column no set names printing nothing. One set inside a strip or a ladder is read by
// setReading; a scheme of one set is still a scheme, `1 × 5 · 100`. `format` spells a load: the
// account's unit by default, `fmtKg` on a form that is written in kilograms.
export function entryLabel(entry, format = fmt) {
  if (entry.sets == null) return OPEN_TARGET;
  const { sets } = entry;
  const reps = sets.map((set) => set.reps ?? null);
  const named = reps.filter((each) => each != null);
  const repsColumn = reps.every((each) => each === reps[0])
    ? String(reps[0] ?? 'max')
    : `${Math.min(...named)}–${named.length < reps.length ? 'max' : Math.max(...named)}`;
  const loads = sets.map((set) => targetLoadOf(set.weightKg));
  const known = loads.filter((each) => each != null);
  if (known.length === 0) return `${sets.length} × ${repsColumn}`;
  const loadColumn = loads.every((each) => each === loads[0])
    ? format(loads[0])
    : `${format(Math.min(...known))}–${known.length < loads.length ? 'last' : format(Math.max(...known))}`;
  return `${sets.length} × ${repsColumn} · ${loadColumn}`;
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

// The instant is the session's start, which is when the plan was frozen.
export function planFrozenLabel(session) {
  if (!planOf(session)) return null;
  return `plan snapshot · frozen ${timeLabel(session.startedAt)}`;
}

export const NOT_IN_PLAN = 'not in the plan';

// Read off the frozen snapshot, never off today's routine; a snapshot entry is the routine entry's
// own shape, `sets` per set, so the reading is the entry itself.
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
  return { kind: 'planned', line: `plan ${entryLabel(entry)}`, entry };
}

// Spelled out to ten; past ten the numeral is what is left.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

export function numberWord(count) {
  return NUMBER_WORDS[count] ?? String(count);
}

// The slot strip as rows, for one movement: what was lifted, in order, then the slots still to
// come. Every set that is not working stands before slot 1 wearing its kind; a working set logged
// past the plan appends as lifted. A planned row is spoken as `set 4, target 100 × 1`.
export function slotRows(sets, entry) {
  const others = sets.filter((set) => set.kind !== 'working').map((set) => ({
    key: set.id, kind: 'warmup', label: `${fmt(set.weightKg)} × ${set.reps} (${set.kind})`,
  }));
  const lifted = sets.filter((set) => set.kind === 'working').map((set) => ({
    key: set.id, kind: 'lifted', label: `${fmt(set.weightKg)} × ${set.reps}`,
  }));
  const coming = (entry?.sets ?? []).slice(lifted.length).map((slot, index) => {
    const n = lifted.length + index + 1;
    return { key: `slot-${n}`, kind: 'target', label: setReading(slot), spoken: `set ${n}, target ${setReading(slot)}` };
  });
  return [...others, ...lifted, ...coming];
}

// Zero is the absence of a load: the movement done at bodyweight. A band-assisted −20 prints itself.
export function setLoadLabel(set, unit = weightUnit()) {
  if (set.weightKg === 0) return `bodyweight × ${set.reps}`;
  return `${fmt(set.weightKg, unit)} × ${set.reps}`;
}

export const NO_ROUTINE = 'Free session';

export function routineNameOf(session) {
  if (typeof session?.routineName === 'string') return session.routineName || null;
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
