// The past workout as the form holds it: movements of sets, each value a number or empty, filled the
// way the rack fills a set (17-set-targets.md) and written to the log in one request.
//
// A draft is `{ routineId, name, minted, movements }`; a movement is `{ key, exerciseId, target,
// lastTime, neverLifted, sets }`, where `target` is the routine entry it came from (null when added
// here), `lastTime` is `{ at, sets }` or null, and `neverLifted` says a read answered that there is
// no history; a set is `{ key, weightKg, reps, touched }`, an empty value null. Every key is minted
// off the draft's own counter, so a row is addressed by what it is and never by where it stands.

import { entryLabel, fmtKg, OPEN_TARGET, schemeAgrees, setCountLabel } from '../log.js';
import { parseEntry } from '../logger/entry.js';
import { round } from '../logger/ladder.js';
import { NO_LAST_TIME_META } from '../logger/movements.js';

const FILLED_FROM_TARGET = 'Filled from the target. A blank load or rep count takes last time’s set.';
const ARRIVES_WITH_LAST_TIME = 'A movement you add arrives with last time’s sets.';
const CARRIES_DOWN = 'An edit carries down to the sets below it you have not touched.';

// The store's own bound on one import.
const SET_LIMIT = 200;
export const SET_LIMIT_LINE = 'A workout holds up to 200 sets.';

const BODYWEIGHT = 'bodyweight';
const LOAD_BOUND_KG = 500;
const REPS_MIN = 1;
const REPS_MAX = 99;
const DEFAULT_STEP_KG = 2.5;
const NUMERAL = /^-?\d*[.,]?\d*$/;

export function movementSkippedLine(movement) {
  return `${movement} is out of this workout.`;
}

export function inTheLogLine(name) {
  return `${name} is in the log.`;
}

export function discardedLine() {
  return 'This workout was saved and then discarded, so this form can’t save it again. Open Add past workout to log it afresh.';
}

export function alreadySavedLine(name) {
  return `${name} was already in the log — the changes made after that save were not written.`;
}

// The reply of `GET /v1/gym/last`: `session` is what says there is history.
function lastTimeOf(reply) {
  if (!reply?.session) return null;
  return { at: reply.session.startedAt, sets: (reply.sets ?? []).map(({ weightKg, reps }) => ({ weightKg, reps })) };
}

// Zero is no named load, the same as an absent one.
function namedLoad(slot) {
  return slot.weightKg == null || slot.weightKg === 0 ? null : slot.weightKg;
}

// The Nth set: the target's own value, then last time's Nth working set, then last time's last set.
function prefilledValues(slot, index, lifted) {
  const matching = lifted[index] ?? lifted[lifted.length - 1] ?? null;
  return { weightKg: namedLoad(slot) ?? matching?.weightKg ?? null, reps: slot.reps ?? matching?.reps ?? null };
}

// A movement as it arrives. An open entry takes last time's working sets as they were lifted, and
// none when it was never lifted; an added one takes them too, or one empty row to type into.
function arrivingMovement({ exerciseId, target, reply, mint }) {
  const lastTime = lastTimeOf(reply);
  const lifted = lastTime?.sets ?? [];
  const values = target?.sets
    ? target.sets.map((slot, index) => prefilledValues(slot, index, lifted))
    : lifted.map(({ weightKg, reps }) => ({ weightKg, reps }));
  const rows = values.length === 0 && !target ? [{ weightKg: null, reps: null }] : values;
  return {
    key: mint('m'),
    exerciseId,
    target,
    lastTime,
    neverLifted: reply != null && !reply.session,
    sets: rows.map((row) => ({ key: mint('s'), ...row, touched: false })),
  };
}

// Mints off the draft's counter and hands back where the counter ended.
function minting(start, build) {
  let next = start;
  const built = build((prefix) => `${prefix}${next++}`);
  return { built, minted: next };
}

// `lastTimes` maps a movement to its `GET /v1/gym/last` reply; a read that failed maps to null.
export function draftFromRoutine(routine, lastTimes) {
  const { built, minted } = minting(0, (mint) => routine.entries.map((entry) => arrivingMovement({
    exerciseId: entry.exerciseId, target: entry, reply: lastTimes.get(entry.exerciseId) ?? null, mint,
  })));
  return { routineId: routine.id, name: routine.name, minted, movements: built };
}

export function freeDraft() {
  return { routineId: null, name: null, minted: 0, movements: [] };
}

export function withMovementAdded(draft, exerciseId, reply) {
  const { built, minted } = minting(draft.minted, (mint) => arrivingMovement({ exerciseId, target: null, reply, mint }));
  return { ...draft, minted, movements: [...draft.movements, built] };
}

export function withMovementRemoved(draft, key) {
  return { ...draft, movements: draft.movements.filter((movement) => movement.key !== key) };
}

export function withMovementAt(draft, index, movement) {
  const at = Math.min(Math.max(index, 0), draft.movements.length);
  return { ...draft, movements: [...draft.movements.slice(0, at), movement, ...draft.movements.slice(at)] };
}

function withMovement(draft, key, change) {
  return { ...draft, movements: draft.movements.map((movement) => (movement.key === key ? change(movement) : movement)) };
}

// `Add set` copies the row above it; with no row above there is nothing to copy.
export function withSetAdded(draft, key) {
  return {
    ...withMovement(draft, key, (movement) => {
      const above = movement.sets[movement.sets.length - 1];
      const copy = { key: `s${draft.minted}`, weightKg: above?.weightKg ?? null, reps: above?.reps ?? null, touched: false };
      return { ...movement, sets: [...movement.sets, copy] };
    }),
    minted: draft.minted + 1,
  };
}

export function withSetRemoved(draft, key, setKey) {
  return withMovement(draft, key, (movement) => ({ ...movement, sets: movement.sets.filter((set) => set.key !== setKey) }));
}

// The straight-scheme rule: a value written into one set is written into every later set of that
// movement the lifter has not touched. Writing the value a set already holds touches it and carries
// nothing: confirming a number is choosing it. `carried` names the sets it landed in besides this one.
function carryDown(movement, setKey, field, value) {
  const index = movement.sets.findIndex((set) => set.key === setKey);
  const changed = movement.sets[index][field] !== value;
  const carried = changed
    ? movement.sets.filter((set, at) => at > index && !set.touched).map((set) => set.key)
    : [];
  const sets = movement.sets.map((set) => {
    if (set.key === setKey) return { ...set, [field]: value, touched: true };
    if (carried.includes(set.key)) return { ...set, [field]: value };
    return set;
  });
  return { movement: { ...movement, sets }, carried };
}

export function withValueSet(draft, key, setKey, field, value) {
  const movement = draft.movements.find((each) => each.key === key);
  const written = carryDown(movement, setKey, field, value);
  return { draft: withMovement(draft, key, () => written.movement), carried: written.carried };
}

const isFilled = (set) => set.weightKg != null && set.reps != null;

// Agreeing sets are one line and a rail; a movement whose sets disagree, or wait for a value, is open.
export function collapses(movement) {
  return movement.sets.length > 0 && movement.sets.every(isFilled) && schemeAgrees(movement.sets);
}

function column(values, format) {
  if (values.length === 0) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? format(low) : `${format(low)}–${format(high)}`;
}

// The routine's own scheme for the movement, in the form's kilograms.
export function targetLine(movement) {
  return entryLabel(movement.target, fmtKg);
}

// The movement's line reads the log's way, in kilograms: `3 × 8 · 60`, and `3 × 6–8` at bodyweight.
// An empty value is left out of its column rather than read as a placeholder. With no sets it reads
// its target, and `no last time` only when the store answered that it never was lifted.
export function movementLine(movement) {
  if (movement.sets.length > 0) {
    const reps = column(movement.sets.map((set) => set.reps).filter((each) => each != null), String) ?? '–';
    const load = column(movement.sets.map(namedLoad).filter((each) => each != null), fmtKg);
    return load ? `${movement.sets.length} × ${reps} · ${load}` : `${movement.sets.length} × ${reps}`;
  }
  if (movement.target?.sets) return targetLine(movement);
  return movement.neverLifted ? `${OPEN_TARGET} · ${NO_LAST_TIME_META}` : OPEN_TARGET;
}

// A number as the row draws it. Zero load is the movement at bodyweight.
export function valueLabel(value, field) {
  if (value == null) return '';
  if (field === 'load' && value === 0) return BODYWEIGHT;
  return field === 'load' ? fmtKg(value) : String(value);
}

// A typed value, or `undefined` when the text is not a plain numeral; an emptied field is empty.
export function typedValue(text, field) {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!NUMERAL.test(trimmed)) return undefined;
  const read = parseEntry({ text: trimmed, seeded: false }, field === 'load' ? 'weight' : 'reps', 0);
  return read.valid ? read.value : undefined;
}

// ↑ and ↓: the load by the movement's plate step, the reps by one.
export function steppedValue(value, field, direction, stepKg) {
  if (field === 'reps') return Math.min(REPS_MAX, Math.max(REPS_MIN, (value ?? 0) + direction));
  const step = stepKg ?? DEFAULT_STEP_KG;
  return Math.min(LOAD_BOUND_KG, Math.max(-LOAD_BOUND_KG, round((value ?? 0) + direction * step)));
}

function setCountOf(draft) {
  return draft.movements.reduce((count, movement) => count + movement.sets.length, 0);
}

export function isOverLimit(draft) {
  return setCountOf(draft) > SET_LIMIT;
}

export function isReady(draft) {
  const count = setCountOf(draft);
  return count > 0 && count <= SET_LIMIT && draft.movements.every((movement) => movement.sets.every(isFilled));
}

export function saveLabel(draft) {
  const count = setCountOf(draft);
  return count === 0 ? 'Save' : `Save · ${setCountLabel(count)}`;
}

export function savedLabel(draft) {
  return `Saved · ${setCountLabel(setCountOf(draft))}`;
}

// What the side column says about where a movement's numbers came from.
export function sourceCaption(movement, edited) {
  if (edited) return CARRIES_DOWN;
  if (movement.target) return FILLED_FROM_TARGET;
  return ARRIVES_WITH_LAST_TIME;
}

// One request, the whole workout, built from what the form holds and nothing else: the set ids are
// the session id's own, numbered, so the same form sends the same bytes and a resend is a replay.
// The set instants are spread evenly strictly inside the span and read as approximate; nothing
// reads a rest interval off them. Every set is a working set.
export function importOf({ id, slot, draft }) {
  const flat = draft.movements.flatMap((movement) => movement.sets.map((set) => ({
    exerciseId: movement.exerciseId, weightKg: set.weightKg, reps: set.reps,
  })));
  const length = slot.finishedAt - slot.startedAt;
  return {
    id,
    startedAt: slot.startedAt,
    finishedAt: slot.finishedAt,
    ...(draft.routineId ? { routineId: draft.routineId } : {}),
    sets: flat.map((set, index) => ({
      id: `${id.replace(/^ses_/, 'set_')}_${index + 1}`,
      ...set,
      completedAt: slot.startedAt + Math.round((length * (index + 1)) / (flat.length + 1)),
      kind: 'working',
    })),
  };
}
