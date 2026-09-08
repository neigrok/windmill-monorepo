import { dayLabel, durLabel, entryLabel, fmt, nameOfMovement, NO_ROUTINE, timeLabel } from './log.js';
import { weightUnit } from './units.js';

export const RECORD_TITLE = 'Personal record';

export function finishHead({ startedAt, finishedAt, routine = null, slight = false, first = false }) {
  return {
    title: slight ? 'Ended early' : 'Session finished',
    subtitle: routine ?? (first ? 'Your first session' : NO_ROUTINE),
    when: `${dayLabel(startedAt)} · ${timeLabel(startedAt)} – ${timeLabel(finishedAt)}`,
  };
}

// No top e1RM is a dash, never a zero.
export function statTiles(stats) {
  return [
    { value: durLabel(stats.durationMs), label: 'Duration' },
    { value: String(stats.workingSets), label: 'Working sets' },
    { value: stats.topE1rm == null ? '—' : fmt(stats.topE1rm), label: 'Top e1RM' },
  ];
}

// `previous` is in the record's own unit — a rep count for reps-at-weight, so it skips `fmt`.
export function recordSentence(record, catalog) {
  if (!record) return null;
  const movement = nameOfMovement(catalog, record.exerciseId);
  const unit = weightUnit();
  const pastFrom = (mark) => `past ${mark} from ${dayLabel(record.previousAt)}`;
  if (record.kind === 'e1rm') return `${movement} e1RM ${fmt(record.value)} ${unit} — ${pastFrom(fmt(record.previous))}.`;
  if (record.kind === 'heaviest') return `${movement} ${fmt(record.value)} ${unit} × ${record.reps} — ${pastFrom(fmt(record.previous))}.`;
  if (record.kind === 'reps-at-weight') return `${movement} ${record.reps} reps at ${fmt(record.weightKg)} ${unit} — ${pastFrom(String(record.previous))}.`;
  return null;
}

// `{sets} × {reps} · {load}`, the scheme's own formula, for the top set and how many of them. Zero is
// the absence of a load, not a load, so a bodyweight effort leaves the column out; a negative
// (band-assisted) load is real.
function effortLabel({ weightKg, reps, sets }) {
  if (weightKg === 0) return `${sets} × ${reps}`;
  return `${sets} × ${reps} · ${fmt(weightKg)}`;
}

// The plan's own top set — the heaviest named load, ties to the earlier set (the backend's TopSet rule
// over the plan) — and the first set when no load is named at all.
function topSetOf(sets) {
  const loaded = sets.filter((set) => set.weightKg != null);
  return loaded.reduce((top, set) => (set.weightKg > top.weightKg ? set : top), loaded[0]) ?? sets[0];
}

// The plan reads in the readout formula and the effort in the same shape. The top set stands against
// the plan's own top set, and `now.sets` counts only the sets at the top load, so short is read on
// reps alone, at a load that did not go up. An open line (`planned: {}`) is nothing to measure
// against, so the row falls through to last time.
function detailOf({ now, before, planned }) {
  const scheme = planned?.sets ?? [];
  if (scheme.length > 0) {
    const top = topSetOf(scheme);
    const short = top.reps != null && now.reps < top.reps && (top.weightKg == null || now.weightKg <= top.weightKg);
    if (short) return `planned ${entryLabel(planned)} — did ${effortLabel(now)}`;
    return `${entryLabel(planned)} → ${effortLabel(now)}`;
  }
  if (before) return `${effortLabel(before)} → ${effortLabel(now)}`;
  return effortLabel(now);
}

export function comparison(against, catalog) {
  if (!against) return null;
  return {
    title: against.routine ? `Against last ${against.routine}` : 'Against last time',
    rows: against.movements.map((movement) => ({
      exerciseId: movement.exerciseId,
      movement: nameOfMovement(catalog, movement.exerciseId),
      detail: detailOf(movement),
    })),
  };
}

// Discarding deletes the session and its sets, and the wire has no restore.
// The discard is withheld like every other delete in this room, so the sentence the transient says
// is all there is: a confirmation on an act that has an undo is ceremony (13-gestures.md Law 2), and
// the words that promised no way back are false now that there is one.
export const SESSION_DELETED = 'Session deleted.';
