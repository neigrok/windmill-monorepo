import { dayLabel, durLabel, fmt, nameOfMovement, NO_ROUTINE, timeLabel } from './log.js';
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

// A missing `reps` means max.
function countLabel({ sets, reps }) {
  if (reps == null) return `${sets} × max`;
  return `${sets}×${reps}`;
}

// Zero is the absence of a load; a negative (band-assisted) load is real.
function topLabel(top) {
  if (top.weightKg == null || top.weightKg === 0) return countLabel(top);
  return `${countLabel(top)} @ ${fmt(top.weightKg)}`;
}

// `now.sets` counts only the sets at the top load, so shortfall is read on reps alone.
function detailOf({ now, before, planned }) {
  const short = planned != null && planned.reps != null && now.reps < planned.reps
    && (planned.weightKg == null || now.weightKg <= planned.weightKg);
  if (short) return `planned ${countLabel(planned)} · did ${countLabel(now)}`;
  if (planned) return `${topLabel(planned)} → ${topLabel(now)}`;
  if (before) return `${topLabel(before)} → ${topLabel(now)}`;
  return topLabel(now);
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
