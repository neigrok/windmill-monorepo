// When a past workout happened: the day in one tap, a default hour clear of the log the page holds, and
// the lifter's own time, which is the only one the form checks against the log.

import { dateLocalOf, msOfDateLocal } from '../bodyweight/bodyweight.js';
import { agoLabel, dayLabel, durLabel, isFinished, NO_ROUTINE, routineNameOf, shortDayLabel, timeLabel } from '../log.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const DURATION_CHIPS = [
  { minutes: 45, label: '45 min' },
  { minutes: 60, label: '1 h' },
  { minutes: 90, label: '1 h 30' },
];

export const DEFAULT_MINUTES = 60;

export const DAY_CHIPS = { today: 'Today', yesterday: 'Yesterday', other: 'Other day' };

const OVERLAP_TITLE = 'These times cross a session already in the log.';
const AHEAD_TITLE = 'These times run past now.';
export const TIME_NEEDED = 'Set a start time for this workout.';

export function todayOf(now) {
  return dateLocalOf(now);
}

// Stepped and not subtracted, so a clock change never lands it two days back or on today.
export function yesterdayOf(now) {
  const day = new Date(now);
  day.setDate(day.getDate() - 1);
  return dateLocalOf(day.getTime());
}

export function dayChipOf(day, now) {
  if (day === todayOf(now)) return 'today';
  if (day === yesterdayOf(now)) return 'yesterday';
  return 'other';
}

// `Today`, `Yesterday`, or the date itself — `22 Sep`.
export function dayNameOf(day, now) {
  const chip = dayChipOf(day, now);
  if (chip === 'other') return shortDayLabel(msOfDateLocal(day));
  return DAY_CHIPS[chip];
}

// `day` is a local `YYYY-MM-DD`; null for anything that is not a real day.
function atClock(day, hour, minute) {
  const midnight = msOfDateLocal(day);
  if (midnight === null) return null;
  const at = new Date(midnight);
  at.setHours(hour, minute, 0, 0);
  return at.getTime();
}

function crosses(slot, span) {
  return slot.startedAt < span.finishedAt && slot.finishedAt > span.startedAt;
}

// What a workout may not cross: every finished session, and the open one from its start until now.
export function busySpans({ sessions, open, now }) {
  const finished = sessions.filter(isFinished)
    .map((session) => ({ session, startedAt: session.startedAt, finishedAt: session.finishedAt }));
  if (!open) return finished;
  return [...finished, { session: open, startedAt: open.startedAt, finishedAt: now }];
}

const MIN_SLOT_MS = 15 * MINUTE_MS;

// The latest a past workout may end: a minute before the minute now is in, so a slot taken now is
// already behind the clock by the time it reaches the store.
function latestEndOf(now) {
  return Math.floor(now / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
}

// The hours a default slot may take: the chosen day's own, and none past the latest end.
function windowOf(day, now) {
  const start = msOfDateLocal(day);
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  return { start, end: Math.min(next.getTime(), latestEndOf(now)) };
}

// Steps a slot off whatever it crosses until it crosses nothing; null once a step leaves the window.
function walked(from, busy, step, outside) {
  const crossing = (slot) => busy.filter((span) => crosses(slot, span));
  let slot = from;
  for (let hit = crossing(slot); hit.length > 0; hit = crossing(slot)) {
    slot = step(hit);
    if (outside(slot)) return null;
  }
  return slot;
}

// Noon to one on the chosen day; today before one, the hour ending at the latest end. A slot that
// crosses a session walks past the latest one it crosses, an hour long; if that runs past the
// window it walks back before the earliest instead, and last it takes what is left after the latest,
// down to fifteen minutes. Every walk stays inside the chosen day. Null when no slot fits: the lifter
// sets the time. Free of every session the page has loaded — one older than the page is the store's
// to refuse, as `session-overlap`.
export function defaultSlot({ day, now, sessions, open }) {
  const busy = busySpans({ sessions, open, now });
  const within = windowOf(day, now);
  const fits = (slot) => slot !== null
    && slot.finishedAt - slot.startedAt >= MIN_SLOT_MS
    && slot.startedAt >= within.start && slot.finishedAt <= within.end
    && busy.every((span) => !crosses(slot, span));

  const noon = atClock(day, 12, 0);
  const first = within.end < noon + HOUR_MS
    ? { startedAt: Math.max(within.end - HOUR_MS, within.start), finishedAt: within.end }
    : { startedAt: noon, finishedAt: noon + HOUR_MS };
  if (fits(first)) return first;

  const later = walked(first, busy, (hit) => {
    const start = Math.max(...hit.map((span) => span.finishedAt));
    return { startedAt: start, finishedAt: start + HOUR_MS };
  }, (slot) => slot.startedAt >= within.end);
  if (fits(later)) return later;

  const earlier = walked(first, busy, (hit) => {
    const end = Math.min(...hit.map((span) => span.startedAt));
    return { startedAt: end - HOUR_MS, finishedAt: end };
  }, (slot) => slot.finishedAt <= within.start);
  const earlierInDay = earlier && { startedAt: Math.max(earlier.startedAt, within.start), finishedAt: earlier.finishedAt };
  if (fits(earlierInDay)) return earlierInDay;

  const laterCut = later && { startedAt: later.startedAt, finishedAt: Math.min(later.finishedAt, within.end) };
  if (fits(laterCut)) return laterCut;
  return null;
}

// A time that ends between the latest end and now is taken as ending at the latest end.
export function chosenSlot({ day, hour, minute, minutes, now }) {
  const startedAt = atClock(day, hour, minute);
  const finishedAt = startedAt + minutes * MINUTE_MS;
  const latest = latestEndOf(now);
  if (finishedAt > latest && finishedAt <= now && latest > startedAt) return { startedAt, finishedAt: latest };
  return { startedAt, finishedAt };
}

// The span that will be stored, read before it is written: `Today · 12:00–13:00`.
export function slotNote(slot, now) {
  const day = dayNameOf(dateLocalOf(slot.startedAt), now);
  return `${day} · ${timeLabel(slot.startedAt)}–${timeLabel(slot.finishedAt)}`;
}

function daySaid(ms, now) {
  const ago = agoLabel(ms, now);
  if (ago === 'today' || ago === 'yesterday') return ago;
  return dayLabel(ms);
}

export function crossedRefusal(session, now) {
  const until = isFinished(session) ? timeLabel(session.finishedAt) : 'now';
  return {
    session,
    title: OVERLAP_TITLE,
    body: `${routineNameOf(session) ?? NO_ROUTINE} · ${daySaid(session.startedAt, now)} · `
      + `${timeLabel(session.startedAt)} – ${until} is already in the log. `
      + 'One visit is one session — if sets are missing from it, add them there instead.',
  };
}

function endsAhead(slot, now) {
  if (slot.finishedAt <= latestEndOf(now)) return null;
  return {
    session: null,
    title: AHEAD_TITLE,
    body: `${dayLabel(slot.startedAt)} · ${timeLabel(slot.startedAt)} for ${durLabel(slot.finishedAt - slot.startedAt)} `
      + 'ends after now. Shorten it, or start it earlier.',
  };
}

// Asked only of a time the lifter set.
export function refusalOf({ slot, busy, now }) {
  const crossed = busy.find((span) => crosses(slot, span));
  if (crossed) return crossedRefusal(crossed.session, now);
  return endsAhead(slot, now);
}
