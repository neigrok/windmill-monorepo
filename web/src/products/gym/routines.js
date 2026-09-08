// Routines as pure rules. Everything here hands back either a WRITE document — the shape POST and PUT
// read, its order carried by the order of its entries and no `position` on an entry, the server
// renumbering densely from what it was sent — or the editor's DRAFT of that same routine. An absent
// optional is omitted, never null. Nothing here mints an id, invents a name, or reads a routine out
// of a plan snapshot: an edit is always a read of the routine itself, changed and written whole.

import { round, snap } from './logger/ladder.js';
import {
  entryLabel, groupByExercise, isUntested, OPEN_TARGET, proposalHref, schemeAgrees, shortDayLabel,
  weekdayName, workingSetsOf,
} from './log.js';
import { conversationOf, historyLabel, isPending, sourceLabel } from './proposals.js';

// THE ROUTINE TARGET'S BANDS, and nothing else's. A set may ask for 1–100 reps (Routine.cpp:23) and a
// scheme holds 1–20 sets; the LIVE LOGGER's reps band is 1–99 and lives in logger/entry.js, which
// enforces it for the fix sheet. The two are different numbers on two screens and each file says
// which it holds.
export const ENTRY_SETS_MIN = 1;
export const ENTRY_SETS_MAX = 20;
export const ENTRY_REPS_MIN = 1;
export const ENTRY_REPS_MAX = 100;

// An absent rep target is the wire's `max`, not a clamped one, and passes through.
function clampReps(reps) {
  if (reps == null) return null;
  return Math.min(ENTRY_REPS_MAX, Math.max(ENTRY_REPS_MIN, reps));
}

// One set on the wire: `reps` then `weightKg`, each present only when named. The one place a set's
// key order is written, so a draft set and a written set are the same bytes.
function setWrite(set) {
  return {
    ...(set.reps == null ? {} : { reps: set.reps }),
    ...(set.weightKg == null ? {} : { weightKg: set.weightKg }),
  };
}

// An entry as a write carries no position. An open line carries nothing but its rest: an entry with
// no `sets` key is the open line, and an empty list is refused by the store like a zero target.
function entryWrite(entry) {
  return {
    exerciseId: entry.exerciseId,
    ...(entry.sets == null ? {} : { sets: entry.sets.map(setWrite) }),
    ...(entry.restSeconds == null ? {} : { restSeconds: entry.restSeconds }),
  };
}

// `lastTrainedAt` and the entry positions are the store's, so neither travels back. `revision` goes
// only when the caller names the one it read; a save over a routine that moved since is then refused
// 409 routine-stale. A write naming none lands unconditionally.
export function routineWrite(routine, readRevision = null) {
  const write = {
    id: routine.id,
    name: routine.name,
    position: routine.position,
    entries: routine.entries.map(entryWrite),
  };
  if (readRevision != null) write.revision = readRevision;
  return write;
}

// In the order performed, every working set transcribed as its own slot — the load as lifted, zero
// included — clipped at the scheme's twenty. Rest is omitted. A movement with no working set is not
// in it.
export function routineFromSession({ id, name, position = 0, sets }) {
  const performed = groupByExercise(workingSetsOf(sets));
  return {
    id,
    name,
    position,
    entries: performed.map(([exerciseId, done]) => ({
      exerciseId,
      sets: done.slice(0, ENTRY_SETS_MAX).map((set) => ({ reps: clampReps(set.reps), weightKg: set.weightKg })),
    })),
  };
}

// Every change lands in this copy and nothing reaches the store until Save. The draft is a whole
// routine, so `routineWrite` sends it whichever way it was born, and no target is invented here.
export function draftFrom(routine) {
  return { ...routine, entries: routine.entries.map((entry) => ({ ...entry })) };
}

export function blankRoutine({ id, position = 0 }) {
  return { id, name: '', position, entries: [] };
}

// A movement joins open; the row reads `open` until it comes back through `Set`.
export function withEntryAdded(entries, exerciseId) {
  return [...entries, { exerciseId }];
}

export function withEntryRemoved(entries, index) {
  return entries.filter((entry, at) => at !== index);
}

// The line goes back where it was. A draft that moved on since is not rewritten: the index is
// clamped to the end rather than opening a hole in a list that is now shorter.
export function withEntryAt(entries, index, entry) {
  const at = Math.min(Math.max(index, 0), entries.length);
  return [...entries.slice(0, at), entry, ...entries.slice(at)];
}

// Deleting a routine takes the proposals anchored to it with it, so the transient names WHICH
// routine left rather than saying that one did.
export function routineDeletedLine(name) {
  return `${name} deleted.`;
}

export function entryDroppedLine(movement) {
  return `${movement} is out of the routine.`;
}

// Both conditions: the routine untested — the store's `lastTrainedAt` absent — AND the row still open.
export function saysNeverLogged(routine, entry) {
  return isUntested(routine) && isOpenEntry(entry);
}

// The sheet hands back a WHOLE entry and this swaps one row for it — never a merge, because the row
// it hands back may be the open one, which has to be able to drop targets the old row was holding.
export function withEntrySet(entries, index, entry) {
  return entries.map((each, at) => (at === index ? entry : each));
}

// Save is inert until the routine has a name, in the editor and on the finish card's offer alike,
// and this is the sentence that says why. Two sites, one string; each phone holds its own copy.
export const NAME_IT_TO_SAVE_IT = 'Name it to save it.';

// The open row names itself `open` in its own target column — that word says WHICH row. The sentence
// says what the word means and is drawn ONCE, on the target sheet while the line being edited is the
// open one: the moment a lifter leaves one open. Never on the list, never per row. The same sentence
// on every surface.
export const OPEN_LINE = 'You decide the numbers at the rack.';

export function isOpenEntry(entry) {
  return entry.sets == null;
}

// The one button is the sheet's own readout: the scheme's reading while every set agrees, and the
// count alone once they do not — the ladder above it has already said the rest.
export function commitLabel(entry) {
  if (isOpenEntry(entry)) return `Set · ${OPEN_TARGET}`;
  if (schemeAgrees(entry.sets)) return `Set · ${entryLabel(entry)}`;
  return `Set · ${entry.sets.length} sets`;
}

// ── The sheet's fields ──────────────────────────────────────────────────────────────────────────
// The sheet holds TEXT, not numbers: what was typed is what is drawn, and a field that refuses keeps
// what the lifter put in it so they can see the thing being refused. Emptying a field IS how it is
// cleared, and the placeholder says what empty means. `sets` is the head's count; `rows` is the
// ladder, one row per set, and it outlives an emptied count — hidden, not thrown away.
export const OPEN_PLACEHOLDER = 'open';
export const MAX_PLACEHOLDER = 'max';
export const LAST_TIME_PLACEHOLDER = 'last time';
// The head's one new word: a column whose rows disagree.
export const VARIES_PLACEHOLDER = 'varies';

// The sheet's chrome, pinned in briefs/17-set-targets.md: with the commit `Set · 5 sets` it is
// fourteen words at first paint.
export const EVERY_SET = 'Every set';
export const SET_BY_SET = 'Set by set';
export const FILL = 'Fill';
export const RAMP_UP = 'Ramp up';
export const MATCH_SET_ONE = 'Match set 1';
export const ADD_SET = 'Add set';
export const SHEET_CHROME = [EVERY_SET, 'Sets', 'Reps', 'Weight', SET_BY_SET, FILL, ADD_SET];

// Pinned in briefs/15-the-routine.md. The reps band here is the ROUTINE TARGET's 1–100; the live
// logger's 1–99 sentence is logger/entry.js's. Each is drawn under the row that carries the fault.
export const ONE_DECIMAL = 'One decimal point only.';
export const NOT_A_NUMBER = 'That is not a number yet.';
export const OVER_MAX_LOAD = 'Over 500 kg — check the number.';
export const REPS_BAND = 'Whole reps, 1 to 100.';
export const SETS_BAND = 'Sets, 1 to 20.';
export const ZERO_TARGET = 'A zero target is no target — clear the field instead.';

// The store's ceiling on a load, the same number the live logger refuses past.
export const MAX_LOAD_KG = 500;

const BLANK_ROW = { reps: '', weight: '' };

// The sheet opens on what the row HOLDS and invents nothing: an open row opens with no count and no
// rows, so the placeholders — `open`, `max`, `last time` — are read on the row they are true of
// rather than hidden behind numbers nobody typed.
export function targetFieldsOf(entry) {
  return {
    sets: entry.sets == null ? '' : String(entry.sets.length),
    rows: (entry.sets ?? []).map((set) => ({
      reps: set.reps == null ? '' : String(set.reps),
      weight: set.weightKg == null ? '' : String(set.weightKg),
    })),
    // The one refusal that cannot be re-derived from the text: a twenty-first row never landed.
    addRefused: false,
  };
}

// The line the sheet holds is OPEN while its count is empty — the one emptiness the sheet reads
// three ways: the sentence it draws, the ladder it hides, and the entry it hands back.
export function isOpenFields(fields) {
  return fields.sets.trim() === '';
}

const numberOf = (text) => Number(text.trim().replace(/,/g, '.'));

// Two weights agree as numbers, so `80` and `80,0` are one load; two empties agree as one absence.
function sameWeightText(left, right) {
  if (left.trim() === '' || right.trim() === '') return left.trim() === right.trim();
  return numberOf(left) === numberOf(right);
}

function sameRow(left, right) {
  return left.reps.trim() === right.reps.trim() && sameWeightText(left.weight, right.weight);
}

// The rows the count names, drawn one per set: none while the line is open, and every row the
// sheet holds while the count is one it refuses — a refused count changes nothing but its own field.
export function ladderOf(fields) {
  if (isOpenFields(fields)) return [];
  if (refusalOf('sets', fields.sets) != null) return fields.rows;
  return fields.rows.slice(0, numberOf(fields.sets));
}

// The head speaks about every ladder row at once: a column whose rows agree reads that text, and one
// whose rows disagree reads empty under `varies` — typing over it writes every row again.
export function headOf(fields) {
  const column = (field, placeholder) => {
    const [first, ...rest] = ladderOf(fields);
    if (!first) return { value: '', placeholder };
    const agree = field === 'reps'
      ? rest.every((row) => row.reps.trim() === first.reps.trim())
      : rest.every((row) => sameWeightText(row.weight, first.weight));
    if (!agree) return { value: '', placeholder: VARIES_PLACEHOLDER };
    return { value: first[field], placeholder };
  };
  return { reps: column('reps', MAX_PLACEHOLDER), weight: column('weight', LAST_TIME_PLACEHOLDER) };
}

// Null for a field that is empty — an empty field is a null target and not a fault.
export function refusalOf(field, text) {
  const raw = (text ?? '').trim();
  if (raw === '') return null;
  const normalised = raw.replace(/,/g, '.');
  if ((normalised.match(/\./g) || []).length > 1) return ONE_DECIMAL;
  const value = Number(normalised);
  if (normalised === '-' || !Number.isFinite(value)) return NOT_A_NUMBER;
  if (value === 0) return ZERO_TARGET;
  if (field === 'weight') return Math.abs(value) > MAX_LOAD_KG ? OVER_MAX_LOAD : null;
  if (field === 'reps') {
    return Number.isInteger(value) && value >= ENTRY_REPS_MIN && value <= ENTRY_REPS_MAX ? null : REPS_BAND;
  }
  return Number.isInteger(value) && value >= ENTRY_SETS_MIN && value <= ENTRY_SETS_MAX ? null : SETS_BAND;
}

// The count grows or shrinks the ladder: a new row copies the row above it, so `5 → 6` on a ramp
// adds a sixth set at the top set's numbers and not a blank. A count below the rows hides the rest
// rather than discarding them — the same rule as an emptied count — so `5 → 1 → 12` on the way to
// typing twelve keeps sets 2 to 5, and a refused count leaves the rows alone.
export function withSets(fields, text) {
  const next = { ...fields, sets: text, addRefused: false };
  if (text.trim() === '' || refusalOf('sets', text) != null) return next;
  const count = numberOf(text);
  const rows = [...fields.rows];
  while (rows.length < count) rows.push({ ...(rows[rows.length - 1] ?? BLANK_ROW) });
  return { ...next, rows };
}

// The copy-down: the head's reps or weight is written into every ladder row.
export function withHead(fields, field, text) {
  const shown = ladderOf(fields).length;
  return {
    ...fields,
    rows: fields.rows.map((row, at) => (at < shown ? { ...row, [field]: text } : row)),
    addRefused: false,
  };
}

export function withRow(fields, index, field, text) {
  return {
    ...fields,
    rows: fields.rows.map((row, at) => (at === index ? { ...row, [field]: text } : row)),
    addRefused: false,
  };
}

// The ladder's last row: one more set at the numbers of the one above it, beneath the rows the
// count names. Inert at twenty, and the refusal is remembered here because the row it would have
// been never landed.
export function withRowAdded(fields) {
  const shown = ladderOf(fields);
  if (shown.length >= ENTRY_SETS_MAX) return { ...fields, addRefused: true };
  const rows = [...shown, { ...(shown[shown.length - 1] ?? BLANK_ROW) }];
  return { ...fields, sets: String(rows.length), rows, addRefused: false };
}

// Deleting a row decrements the count; deleting the last one is the same act as clearing the count
// and lands on the same open line.
export function withRowRemoved(fields, index) {
  const rows = ladderOf(fields).filter((row, at) => at !== index);
  return { ...fields, sets: rows.length === 0 ? '' : String(rows.length), rows, addRefused: false };
}

// Nothing to ramp between: fewer than three rows, or a first and last row that agree.
export function rampDisabled(fields) {
  const rows = ladderOf(fields);
  return rows.length < 3 || sameRow(rows[0], rows[rows.length - 1]);
}

// The pyramid in two typed ends and one tap: reps and load interpolated from set 1 to set n, the
// ends left exactly as typed and each load between them snapped onto the plate grid — the band's
// small step, half away from zero — the same rule on all three surfaces. A column with an empty end
// is left as it stands.
export function withRampUp(fields) {
  const rows = ladderOf(fields);
  const last = rows.length - 1;
  const ends = (field) => {
    const from = rows[0][field];
    const to = rows[last][field];
    if (from.trim() === '' || to.trim() === '') return null;
    return [numberOf(from), numberOf(to)];
  };
  const reps = ends('reps');
  const weight = ends('weight');
  const at = (pair, index, put) => String(put(pair[0] + ((pair[1] - pair[0]) * index) / last));
  const between = (index) => index !== 0 && index !== last;
  return withLadder(fields, rows.map((row, index) => ({
    reps: reps && between(index) ? at(reps, index, Math.round) : row.reps,
    weight: weight && between(index) ? at(weight, index, snap) : row.weight,
  })));
}

// The way back from a ladder to a straight scheme without retyping the head.
export function withMatchedToFirst(fields) {
  const rows = ladderOf(fields);
  return withLadder(fields, rows.map(() => ({ ...rows[0] })));
}

// A fill writes the ladder's rows and leaves the hidden ones as they were.
function withLadder(fields, ladder) {
  return {
    ...fields,
    rows: fields.rows.map((row, at) => (at < ladder.length ? ladder[at] : row)),
    addRefused: false,
  };
}

// `±` on a bodyweight movement's load field — one row's, or with no row named the head's, which
// writes every ladder row: band-assisted work is a negative load and a decimal keyboard offers no
// sign. It flips the leading sign of the TEXT and never leaves a bare `-` behind — an empty field
// has no sign to flip, so the press is a no-op rather than a refusal.
export function withSignFlipped(fields, index = null) {
  const text = (index == null ? headOf(fields).weight.value : fields.rows[index].weight).trim();
  if (text === '') return fields;
  const flipped = text.startsWith('-') ? text.slice(1) : `-${text}`;
  if (index == null) return withHead(fields, 'weight', flipped);
  return withRow(fields, index, 'weight', flipped);
}

// One refusal on the sheet at a time, drawn under the field it belongs to, topmost first: the
// twenty-first row that never landed, then the count, then the rows top to bottom — and the rows
// only while the count names them, since a hidden ladder is not what the commit hands back.
export function targetRefusal(fields) {
  if (fields.addRefused) return { field: 'add', row: null, message: SETS_BAND };
  const sets = refusalOf('sets', fields.sets);
  if (sets) return { field: 'sets', row: null, message: sets };
  for (const [row, texts] of ladderOf(fields).entries()) {
    for (const field of ['reps', 'weight']) {
      const message = refusalOf(field, texts[field]);
      if (message) return { field, row, message };
    }
  }
  return null;
}

// What the row becomes: the rows the count names, and never a hidden one. A count cleared is the
// open line, which carries nothing but its rest; the clamp stays as the last guard, so no value this
// screen let through can reach the store out of band. A load is put on the ladder's grid before it
// is stored — the same `round` the rack keypad commits through — so a target and the set that meets
// it are the same number and not two.
export function targetEntryOf(entry, fields) {
  if (isOpenFields(fields)) {
    return { exerciseId: entry.exerciseId, ...(entry.restSeconds == null ? {} : { restSeconds: entry.restSeconds }) };
  }
  return {
    ...entry,
    sets: ladderOf(fields).map((row) => setWrite({
      reps: row.reps.trim() === '' ? null : clampReps(numberOf(row.reps)),
      weightKg: row.weight.trim() === '' ? null : round(numberOf(row.weight)),
    })),
  };
}

// The numbering is rewritten from the new order every time. A drop below the last row arrives as an
// index one past the end and is clamped.
export function reorderEntries(entries, from, to) {
  if (entries.length === 0) return [];
  const last = entries.length - 1;
  const moved = [...entries];
  const [entry] = moved.splice(Math.min(Math.max(from, 0), last), 1);
  moved.splice(Math.min(Math.max(to, 0), last), 0, entry);
  return moved.map((each, index) => ({ ...each, position: index + 1 }));
}

// The routine's name is dropped rather than printed empty for a routine still being named.
export function entryPlaceLabel(index, count, routineName) {
  const named = (routineName ?? '').trim();
  if (named === '') return `${index + 1} of ${count}`;
  return `${index + 1} of ${count} · ${named}`;
}

// The count is the store's `movements` — the lines the routine was created with — and is absent where
// none was stored; today's entry count is not a substitute. Past six days the weekday alone repeats.
const WEEKDAY_MS = 6 * 86400000;

export function builtLabel(routine, now = Date.now()) {
  const created = (routine?.history ?? []).find((row) => row.kind === 'created');
  if (!created) return null;
  const when = now - created.at >= WEEKDAY_MS ? shortDayLabel(created.at) : weekdayName(created.at);
  if (created.movements == null) return `built ${when}`;
  const movements = created.movements === 1 ? '1 movement' : `${created.movements} movements`;
  return `built ${when} · ${movements}`;
}

// Two kinds of row, newest first, the `created` row always last and always there. A created row with
// no `by` is the lifter's own hand, and the absence is the whole claim.
export function historyRows(routine) {
  return (routine?.history ?? []).map((row, index) => {
    if (row.kind === 'created') {
      const what = row.by == null ? 'created by you' : `created by ${sourceLabel({ door: row.by })}`;
      const movements = row.movements == null ? null : `${row.movements} movements`;
      return {
        key: `created-${index}`,
        pending: false,
        href: null,
        line: [shortDayLabel(row.at), what, movements].filter((part) => part != null).join(' · '),
      };
    }
    // `source.thread` absent means there is nothing to open; the row still names the door.
    return {
      key: row.proposal.id,
      pending: isPending(row.proposal),
      href: proposalHref(row.proposal.id),
      thread: conversationOf(row.proposal.source),
      line: historyLabel(row.proposal),
    };
  });
}

