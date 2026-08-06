// THE STATISTICS SURFACE, AS RULES — how a training log reads over months rather than over one
// session. No React and no fetch in here, exactly like log.js and review.js: the screen draws what
// this returns and decides nothing, and the tests read the same rules without a browser.
//
// NOTHING HERE IS ARITHMETIC ABOUT TRAINING. Every number on this surface was decided by the domain
// and arrives on the wire already made — the e1RM (Epley, one copy per language, and never in the
// database), the top working set of a movement in a session, the standing bests, the per-week
// counts Postgres made. What this file does is choose a WINDOW and turn numbers into geometry, and
// that is the whole of its job. A second opinion computed here would be the product arguing with
// itself across two screens.
//
// WHAT IS NOT ON THIS SURFACE, each for a reason that has not changed:
//   · muscle-group volume, and any taxonomy for it — pattern is gym's only classification and it is
//     single-valued on purpose, which is what makes Lift's double-counted bench set unrepresentable
//   · volume as a headline number — band-assisted work logs a negative load, so weight × reps falls
//     as a lifter gets stronger, and four light sets outrank three heavy ones
//   · streaks, cardio, any duration axis
//   · every grade, score, percentage and green/red. The finish screen's rule holds over a longer
//     window: a fact with a direction, never a grade (review.js).
//
// AND THE AXES ARE HONEST BY CONSTRUCTION. Counts are bars, so they start at zero because a bar's
// length IS its value. A movement's line runs from zero (or from the lowest assisted load, when
// that is below zero) to its own top, and NEVER shares a scale with another movement's — an
// unnormalised shared Y axis is the first bug in Lift's Progress tab and it is a drawing decision,
// not a data one, so it is designed out here rather than watched for later.

import { agoLabel, dayLabel, fmt, nameOfMovement } from './log.js';

// Twelve weeks is a quarter, which is the window a program is actually judged over, and twelve
// points is a phone's width divided by a marker you can see. Both are the SCREEN's business — the
// read carries the whole history (gymApi.js), so widening either is one number here and no request.
export const WEEK_WINDOW = 12;
export const POINT_WINDOW = 12;
// How many movement cards open with. A log with forty movements is a scroll nobody reads; the rest
// are one tap away and nothing is hidden.
export const MOVEMENT_PAGE = 6;

// The plot box, in its own units. The SVG scales uniformly to whatever width it is given, so these
// are proportions rather than pixels — and the markers stay round, which they would not under a
// stretched viewBox.
export const PLOT = { width: 300, height: 88, padX: 5, padY: 9, dot: 3.6 };

const round2 = (value) => Math.round(value * 100) / 100;

const countLabel = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// The weeks, windowed and turned into bar heights. Two series over one set of columns — sessions
// and working sets — and they are drawn as two separate charts against two separate maxima, never
// as one chart with two Y axes: a dual axis lets whoever picked the scales decide which line looks
// like it is winning, which is the loudest way to turn a fact into a grade.
//
// A week nobody trained arrives from the store as a present zero rather than as a gap (the read
// fills the span with generate_series), so nothing here synthesizes a calendar — the bar is simply
// absent at zero height, which is what zero looks like.
export function weekBars(weeks, window = WEEK_WINDOW) {
  const shown = weeks.slice(Math.max(0, weeks.length - window));
  // Never zero: a divisor of zero would be a NaN in a style attribute, and the series ends at the
  // last week trained, so a shown window whose every bar is empty is not reachable by data.
  const sessionsMax = Math.max(1, ...shown.map((week) => week.sessions));
  const setsMax = Math.max(1, ...shown.map((week) => week.workingSets));
  return {
    bars: shown.map((week) => ({
      startedAt: week.startedAt,
      sessions: week.sessions,
      workingSets: week.workingSets,
      sessionsPct: round2((week.sessions / sessionsMax) * 100),
      setsPct: round2((week.workingSets / setsMax) * 100),
      // A BAR HAS NO TEXT ON IT, so this is the whole of what a reader who is listening to this
      // screen gets — and it is written here, with the rest of the copy, rather than assembled in
      // a view where "1 sessions" is one interpolation away.
      sessionsLabel: `week of ${dayLabel(week.startedAt)}: ${countLabel(week.sessions, 'session', 'sessions')}`,
      setsLabel: `week of ${dayLabel(week.startedAt)}: ${countLabel(week.workingSets, 'working set', 'working sets')}`,
    })),
    sessionsMax,
    setsMax,
    // The ends of the window, spelled as days rather than as "the last 12 weeks" — the series ends
    // at the last week TRAINED and not at this week, so a relative phrase would quietly claim
    // somebody trained recently. The dates say what is actually on screen.
    from: shown.length > 0 ? dayLabel(shown[0].startedAt) : null,
    to: shown.length > 0 ? dayLabel(shown[shown.length - 1].startedAt) : null,
    older: weeks.length - shown.length,
    // What the window left out, said out loud — a lifter who has just imported years of training
    // is entitled to know the chart is a quarter of it and not the whole thing.
    olderLabel: weeks.length > shown.length
      ? `${countLabel(weeks.length - shown.length, 'earlier week', 'earlier weeks')} not shown`
      : null,
  };
}

// WHICH AXIS A MOVEMENT'S LINE IS DRAWN ON, and it is decided by the data rather than by a setting.
// Three cases, and the third is the one a chin-up needs:
//   · every point has an estimate — the line is e1RM, the movement's own strength curve
//   · the estimate is missing somewhere but the load moves — the line is the top set's LOAD, which
//     is the honest axis across the band-assisted → bodyweight → weighted crossing that made the
//     estimate undefined in the first place (Epley has no answer at or below zero)
//   · the load never moves — then the load is not the story and the reps are. The point is already
//     the heaviest set, ties going to more reps, so at one fixed load "the top set" IS the best set
//     of reps at it, and plotting anything else would be plotting a constant.
export function axisOf(points) {
  if (points.length > 0 && points.every((point) => point.e1rm != null)) return 'e1rm';
  if (new Set(points.map((point) => point.weightKg)).size > 1) return 'load';
  return 'reps';
}

export function valueOf(point, axis) {
  if (axis === 'e1rm') return point.e1rm;
  if (axis === 'load') return point.weightKg;
  return point.reps;
}

export const AXIS_CAPTION = { e1rm: 'e1RM · kg', load: 'top set · kg', reps: 'top set · reps' };

// The line, as geometry. The Y axis runs from zero to the series' own top — and DOWN to the lowest
// value when that is below zero, because a band-assisted load is a real point on this number line
// and an axis that clipped it would draw the assistance coming off as nothing happening. Zero is
// therefore always inside the range, which is what makes the shape readable as a magnitude rather
// than as a magnified wobble.
//
// Returns null when the range has no height — a movement logged only ever at one load with no
// estimate, on the reps axis with one rep count. There is nothing to draw and the facts under the
// chart already say it; a flat line pinned to the middle of a box would be a chart drawn out of
// politeness.
export function linePlot(values, box = PLOT) {
  if (values.length === 0) return null;
  const top = Math.max(0, ...values);
  const floor = Math.min(0, ...values);
  const span = top - floor;
  if (span === 0) return null;

  const inner = { width: box.width - box.padX * 2, height: box.height - box.padY * 2 };
  const at = (value) => round2(box.padY + ((top - value) / span) * inner.height);
  const dots = values.map((value, index) => ({
    // One point sits in the middle rather than on the left edge: a single session is not the start
    // of a trend and should not be drawn as one.
    x: round2(values.length === 1
      ? box.width / 2
      : box.padX + (index / (values.length - 1)) * inner.width),
    y: at(value),
    value,
  }));

  return {
    ...box,
    dots,
    path: dots.map((dot, index) => `${index === 0 ? 'M' : 'L'}${dot.x},${dot.y}`).join(' '),
    // Zero is always in range and the rule is always drawn, because being able to SEE where zero is
    // is the whole of what a zero-based axis buys. On an all-positive series it is the floor of the
    // plot; on a movement that started band-assisted it sits inside it, and the line coming up
    // through it is the assistance coming off.
    zeroY: at(0),
    top,
    floor,
  };
}

// The standing bests, which are the finish screen's record rules asked with no session to compare
// against (backend domain/Statistics.h). They are printed as facts and never as trophies: no medal,
// no "new", no colour — the record MOMENT is the finish screen's and it happens once.
//
// The third record rule has no standing form and is deliberately absent here: "more reps at a load
// you have used before" is a comparison, and with nothing to compare against every mark already is
// the best reps ever done at its load.
function bestLines(movement) {
  const lines = [];
  if (movement.bestE1rm?.e1rm != null) {
    lines.push({
      label: 'Best e1RM',
      value: `${fmt(movement.bestE1rm.e1rm)} kg`,
      when: dayLabel(movement.bestE1rm.at),
    });
  }
  if (movement.heaviest) {
    lines.push({
      label: 'Heaviest',
      value: `${fmt(movement.heaviest.weightKg)} kg × ${movement.heaviest.reps}`,
      when: dayLabel(movement.heaviest.at),
    });
  }
  return lines;
}

export function movementCard(movement, catalog, { window = POINT_WINDOW, now = Date.now() } = {}) {
  const shown = movement.points.slice(Math.max(0, movement.points.length - window));
  const axis = axisOf(shown);
  const values = shown.map((point) => valueOf(point, axis));
  const plot = linePlot(values);
  const name = nameOfMovement(catalog, movement.exerciseId);
  // The axis says its own range in words beside the chart. A reader who cannot see where a scale
  // starts has to trust it, and trusting a scale is the thing the whole zero-based rule exists to
  // make unnecessary. The dash is spaced because a floor below zero is a real case here, and
  // `−20–0` closed up is two minus signs and a range nobody can read.
  const caption = plot
    ? `${AXIS_CAPTION[axis]} · ${fmt(plot.floor)} – ${fmt(plot.top)}`
    : AXIS_CAPTION[axis];
  // The ends of the line, in words, because a chart with no tooltip has to say its own numbers —
  // this product is read on a phone at a rack, where there is no hover to reveal anything.
  const first = values.length > 1 ? { value: fmt(values[0]), when: dayLabel(shown[0].at) } : null;
  const last = values.length > 0
    ? { value: fmt(values[values.length - 1]), when: dayLabel(shown[shown.length - 1].at) }
    : null;

  return {
    exerciseId: movement.exerciseId,
    name,
    lastTrained: agoLabel(movement.lastTrainedAt, now),
    axis,
    caption,
    plot,
    first,
    last,
    // The line as a sentence — the whole of what a reader who is listening to this screen gets off
    // a chart, so it is written beside the copy rather than interpolated in a view.
    summary: first
      ? `${name} — ${caption}, ${countLabel(shown.length, 'session', 'sessions')} from ${first.value} to ${last.value}`
      : `${name} — ${caption}, one session at ${last?.value ?? '—'}`,
    sessions: shown.length,
    older: movement.points.length - shown.length,
    bests: bestLines(movement),
  };
}

// The whole surface, made once. `now` is passed rather than read so the same log renders the same
// screen in a test, and so nothing on the surface is a claim only the device's clock can support.
export function statsView(stats, catalog, { now = Date.now() } = {}) {
  return {
    weeks: weekBars(stats.weeks ?? []),
    movements: (stats.movements ?? []).map((movement) => movementCard(movement, catalog, { now })),
  };
}

// Nothing has been counted yet — no finished session anywhere in the log. Said as a state of the
// log rather than as an emptiness of this screen, because that is what it is.
export function isEmpty(view) {
  return view.weeks.bars.length === 0 && view.movements.length === 0;
}
