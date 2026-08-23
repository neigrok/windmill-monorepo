import {
  dayLabel, durLabel, EMPTY_BAR_KG, EMPTY_BAR_REPS, fmtKg, isFinished, NO_ROUTINE, routineNameOf,
  setCountLabel, timeLabel,
} from './log.js';

const DAY_MS = 86400000;

export const DAY_CHIP_OFFSETS = [1, 2, 5];
export const DEFAULT_START_HOUR = 17;
export const DEFAULT_START_MINUTE = 30;

export const DURATION_CHIPS = [
  { minutes: 45, label: '45 min' },
  { minutes: 60, label: '1 h' },
  { minutes: 90, label: '1 h 30' },
];

export const MID_WORKOUT_REFUSAL = {
  title: 'A session is already running.',
  body: 'Live training happens on your phone — one workout is open at a time, and this one waits for it. The door opens when it closes.',
};

export const OVERLAP_TITLE = 'These times cross a session already in the log.';
export const AHEAD_TITLE = 'These times run past now.';

export function endsAhead({ startedAt, durationMs }, now = Date.now()) {
  if (startedAt + durationMs <= now) return null;
  return {
    title: AHEAD_TITLE,
    body: `${dayLabel(startedAt)} · ${timeLabel(startedAt)} for ${durLabel(durationMs)} ends after now. Shorten it, or start it earlier.`,
  };
}

export function dayChips(now = Date.now()) {
  return DAY_CHIP_OFFSETS.map((days) => ({
    days,
    label: days === 1 ? 'Yesterday' : dayLabel(now - days * DAY_MS),
  }));
}

export function startedAtOf({ days, hour = DEFAULT_START_HOUR, minute = DEFAULT_START_MINUTE, now = Date.now() }) {
  const day = new Date(now - days * DAY_MS);
  day.setHours(hour, minute, 0, 0);
  return day.getTime();
}

export function totalSets(blocks) {
  return blocks.reduce((total, block) => (
    total + block.lines.reduce((count, line) => count + line.sets, 0)
  ), 0);
}

export function saveLabel(blocks) {
  return `Add to the log · ${setCountLabel(totalSets(blocks))}`;
}

export function saveNote(startedAt) {
  return `Lands under ${dayLabel(startedAt)} · set times will read as approximate.`;
}

export function lineLabel(line) {
  return `${fmtKg(line.weightKg)} × ${line.reps}`;
}

const OPENING_LINE = { weightKg: EMPTY_BAR_KG, reps: EMPTY_BAR_REPS, sets: 3, kind: 'working' };

export function withMovementAdded(blocks, exerciseId) {
  return [...blocks, { exerciseId, lines: [{ ...OPENING_LINE }] }];
}

export function withLineAdded(blocks, blockIndex) {
  return blocks.map((block, at) => (at !== blockIndex ? block : {
    ...block,
    lines: [...block.lines, { ...block.lines[block.lines.length - 1], kind: 'working' }],
  }));
}

export const LINE_SETS_MIN = 1;
export const LINE_SETS_MAX = 12;

export function withLineChanged(blocks, blockIndex, lineIndex, change) {
  return blocks.map((block, at) => (at !== blockIndex ? block : {
    ...block,
    lines: block.lines.map((line, index) => {
      if (index !== lineIndex) return line;
      const changed = { ...line, ...change };
      return { ...changed, sets: Math.min(LINE_SETS_MAX, Math.max(LINE_SETS_MIN, changed.sets)) };
    }),
  }));
}

export function withLineRemoved(blocks, blockIndex, lineIndex) {
  return blocks
    .map((block, at) => (at !== blockIndex ? block : {
      ...block,
      lines: block.lines.filter((line, index) => index !== lineIndex),
    }))
    .filter((block) => block.lines.length > 0);
}

// Set instants are SYNTHESIZED — spread evenly, strictly inside the span, never remembered — so
// nothing downstream may read rest intervals off them.
export function expandLines({ startedAt, durationMs, blocks, mint }) {
  const flat = blocks.flatMap((block) => block.lines.flatMap((line) => (
    Array.from({ length: line.sets }, () => ({
      exerciseId: block.exerciseId,
      weightKg: line.weightKg,
      reps: line.reps,
      kind: line.kind,
    }))
  )));
  return flat.map((set, index) => ({
    id: mint('set_'),
    ...set,
    completedAt: startedAt + Math.round((durationMs * (index + 1)) / (flat.length + 1)),
  }));
}

export function overlapWith({ startedAt, durationMs }, sessions) {
  const endsAt = startedAt + durationMs;
  const crossed = sessions.find((session) => isFinished(session)
    && startedAt < session.finishedAt && endsAt > session.startedAt);
  if (!crossed) return null;
  const span = `${timeLabel(crossed.startedAt)} – ${timeLabel(crossed.finishedAt)}`;
  return {
    session: crossed,
    title: OVERLAP_TITLE,
    body: `${routineNameOf(crossed) ?? NO_ROUTINE} · ${dayLabel(crossed.startedAt)} · ${span} `
      + 'is already in the log. One visit is one session — if sets are missing from it, add them there instead.',
  };
}

export async function fileBackfill({ api, id, sets, finishedAt }) {
  let landed = 0;
  // Never break this loop: every set is offered, or `landed` is a lower bound.
  for (const set of sets) {
    const stored = await api.appendSet(id, set).then(() => true).catch(() => false);
    if (stored) landed += 1;
  }
  const closed = await api.finishSession(id, { finishedAt }).then(() => true).catch(() => false);
  if (landed === sets.length) return { total: sets.length, landed, closed, undone: false };
  // Close before discarding: the store refuses to discard a running session.
  const undone = closed && (await api.discardSession(id).then(() => true).catch(() => false));
  return { total: sets.length, landed, closed, undone };
}

// `kept` holds the draft in the form.
export function saveReport({ total, landed, startedAt, closed, undone }) {
  if (landed < total && undone) {
    return {
      kept: true,
      text: `The log took ${landed} of ${setCountLabel(total)}, so nothing was added. `
        + 'Your workout is still here — try again when you have signal.',
    };
  }
  if (landed < total) {
    return {
      kept: true,
      text: `The log took ${landed} of ${setCountLabel(total)}, and that session couldn’t be undone. `
        + `It is under ${dayLabel(startedAt)} — your workout is still here.`,
    };
  }
  if (!closed) {
    return { kept: false, text: `Added to the log · ${dayLabel(startedAt)} · it closes on its own within four hours.` };
  }
  return { kept: false, text: `Added to the log · ${dayLabel(startedAt)} · ${setCountLabel(total)}` };
}
