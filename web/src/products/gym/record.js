// A MOVEMENT'S RECORD, AS RULES (§H) — one exercise, one page, and the whole of what this layer
// decides: which of the four blocks there is anything honest to draw, and how a number becomes a
// bar. No React and no fetch in here, exactly like log.js and review.js: the screen draws what this
// returns and decides nothing, and the tests read the same rules without a browser.
//
// NOTHING HERE IS ARITHMETIC ABOUT TRAINING. Every number arrives already made — the e1RM (Epley,
// one copy per language, and never in the database), the best of them, the ladder of records that
// were passed, the per-session series (gymApi.js). A second opinion computed here would be the
// product arguing with itself between this page and the finish screen.
//
// THE TWO REAL RULES OF THE RETIRED STATISTICS SURFACE LIVE HERE NOW, because they were rules about
// honesty and not about that room:
//   · EPLEY IS UNDEFINED AT OR BELOW ZERO LOAD. The wire says so by omission — a bodyweight or a
//     band-assisted movement carries no `bestE1rm`, no `e1rmSeries` and no `records` — and this
//     draws NOTHING for it: no tile, no chart, and never a dash inside a chart frame. That surface
//     answered the same question by switching a movement's line to the load or the reps axis; §H
//     asks for one chart of one figure, so the honest answer here is the absence rather than a
//     different quantity plotted under the same caption.
//   · THE SCALE STARTS AT ZERO. A bar's LENGTH is its value, so a truncated bar is simply the wrong
//     length: 116.7 and 122.5 drawn on a 116–123 floor is a lifter doubling their bench.
//
// AND ONE RULE §H OVERRULES, here and only here. That surface printed its standing bests grey, arguing
// that the record MOMENT belongs to the finish screen and happens once. This page IS the mark — it
// is what somebody opens to ask where a movement stands — so the best wears the gold (--pr-ink) and
// the finish screen keeps the moment.

import { agoLabel, e1rmLabel, fmt, setLoadLabel, shortDayLabel } from './log.js';

const round2 = (value) => Math.round(value * 100) / 100;

const countLabel = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// Nothing has been worked yet. Said as a state of the movement rather than as an emptiness of this
// page, and it is a common state: sixty-four movements ship with every account.
export const NEVER_LOGGED = 'You haven’t worked this movement yet.';
export const NEVER_LOGGED_LINE = 'The first set you log against it lands here.';

// 'today' and 'yesterday' by name, every other day by its date — the log row's own rule
// (logWhenLabel), minus the clock: on this page the hour a personal record happened is not what
// anybody came for, and twelve weekday prefixes down one column are noise.
export function whenOf(ms, now) {
  const ago = agoLabel(ms, now);
  if (ago === 'today' || ago === 'yesterday') return ago;
  return shortDayLabel(ms);
}

// THE TWO COUNTS THE WIRE SENDS COUNT DIFFERENT THINGS, ON PURPOSE (backend domain/Record.h).
// `sessionCount` is the sessions this movement was WORKED in — every number in this product is over
// working sets — while `recentDays` holds every day it was trained in at all bar a warmup, because
// a list of what you did that dropped a drop set would claim to be complete and not be. So a
// movement logged only as a drop or a failure set counts zero and still has sets to show, and the
// page has to read BOTH before it says anything about whether the log holds it.
function inTheLog(record) {
  return record.sessionCount > 0 || (record.recentDays ?? []).length > 0;
}

// What the movement IS, in one line under its name: how it is loaded, how much of the program names
// it, and how much of the log holds it. Every one of the three is a fact the store counted.
export function subheadOf(record) {
  const routines = record.routineCount === 0
    ? 'in no routine'
    : `in ${countLabel(record.routineCount, 'routine', 'routines')}`;
  if (record.sessionCount > 0) {
    const sessions = countLabel(record.sessionCount, 'session', 'sessions');
    return `${record.exercise.equipment} · ${routines} · ${sessions}`;
  }
  // 'never logged' rather than '0 sessions' — it is the picker's own word for a movement nobody has
  // worked, and a zero counted out loud reads as a score. It is only true of a movement with
  // nothing at all in the log, though: a drop set is a set somebody did, so a movement that has
  // only ever been dropped says what the zero actually is instead of claiming it was never touched.
  const sessions = inTheLog(record) ? 'no working sets' : 'never logged';
  return `${record.exercise.equipment} · ${routines} · ${sessions}`;
}

// THE TWO TILES, AND EITHER MAY BE ABSENT. A movement with no estimate has no best e1RM at all, and
// a movement nobody has worked has neither — the page is then a name, a line and nothing pretending
// to be a number.
export function tilesOf(record, now) {
  const tiles = [];
  if (record.bestE1rm) {
    tiles.push({
      label: 'best e1RM',
      value: fmt(record.bestE1rm.e1rm),
      // The set that made it, so the headline number is never a figure with no set behind it.
      sub: `${whenOf(record.bestE1rm.at, now)} · ${setLoadLabel(record.bestE1rm)}`,
      standing: true,
    });
  }
  if (record.heaviest) {
    // ZERO IS NOT A LOAD, IT IS THE ABSENCE OF ONE — the rule the finish comparison, the routine
    // target and the log's own set line all read. So the heaviest a dip or a chin-up has ever been
    // is a number of REPS, and '0 kg · for 12' was this tile printing a weight nobody lifted. A
    // band-assisted −20 still prints its load, being a real point on this number line.
    const { weightKg, reps } = record.heaviest;
    tiles.push(weightKg === 0
      ? { label: 'heaviest', value: String(reps), sub: 'reps · bodyweight', standing: false }
      : { label: 'heaviest', value: fmt(weightKg), sub: `kg · for ${reps}`, standing: false });
  }
  return tiles;
}

// ONE CHART, AND IT IS BARS. A training log is discrete events, and a line between them implies days
// that never happened — which is exactly what a chart of a program a lifter took a fortnight off in
// would say. Returns null when there is nothing honest to plot, and the page then draws no frame,
// no axis and no empty box.
export function chartOf(record, now) {
  const series = record.e1rmSeries ?? [];
  if (series.length === 0) return null;
  const top = Math.max(...series.map((point) => point.e1rm));
  // Epley answers only above zero load, so an estimate on the wire is a positive number and this
  // divisor cannot be zero on real data. The guard is against a wire that broke that promise, and it
  // is written as "unless the top is a number above zero" rather than as `top <= 0`: a point with no
  // estimate makes the top NaN, every comparison with NaN is false, and the chart drew a row of
  // `height:NaN%` bars — no height at all, and nothing on the page saying why.
  if (!(top > 0)) return null;
  // AT MOST ONE GOLD BAR, and it is the one the tile above the chart prints — the session holding
  // the standing best. Marking every session that ever beat the one before it turned a third of a
  // quarter's bars gold, and a colour that means "a record happened here" stops meaning it when it
  // is on three bars at once (the palette's rule: a PR is a KIND of moment, at most one). The rest
  // of the ladder is under the chart in words. A best set OLDER than this window leaves no gold bar
  // at all, which is the honest reading of a quarter that beat nothing.
  const standingAt = record.bestE1rm?.at ?? null;
  return {
    bars: series.map((point) => ({
      at: point.at,
      pct: round2((point.e1rm / top) * 100),
      standing: point.at === standingAt,
      // A BAR CARRIES NO TEXT, so this is the whole of what a reader listening to this page gets off
      // the chart, and it is written here with the rest of the copy rather than interpolated in a
      // view where a spacing changes the sentence.
      label: `${whenOf(point.at, now)} · ${setLoadLabel(point)} · ${e1rmLabel(point.e1rm)}`,
    })),
    top,
    // The ends of the window, spelled as the days that are actually on screen. The window itself is
    // the server's twelve weeks and the caption says so — but a series that ended a month ago must
    // not be read as training that happened last week, and the two dates are what settle it.
    from: shortDayLabel(series[0].at),
    to: shortDayLabel(series[series.length - 1].at),
  };
}

// EVERY SESSION THAT BEAT EVERY SESSION BEFORE IT, newest first, over the whole log rather than over
// the chart's quarter. The first session is deliberately not one of them: a mark has to be passed.
export function recordsOf(record, now) {
  return (record.records ?? []).map((mark, index) => ({
    at: mark.at,
    load: setLoadLabel(mark),
    e1rm: e1rmLabel(mark.e1rm),
    when: whenOf(mark.at, now),
    // Newest first, so the first row is the mark that still stands — the one the tile above prints.
    standing: index === 0,
  }));
}

// The last ten times this movement was trained, as they were performed. ONE ROW IS ONE SESSION,
// under the day it happened: the wire's `recentDays` is keyed by session, and two workouts on one
// day print that day twice rather than folding into a row claiming to be one workout. Read-only,
// and they say nothing about being tappable: correcting a set is W3's, and an affordance that does
// nothing would be worse than none.
export function daysOf(record, now) {
  return (record.recentDays ?? []).map((day) => ({
    sessionId: day.sessionId,
    when: whenOf(day.startedAt, now),
    // ONE WORD FOR WHAT COUNTS. Warmups are already off this wire; a drop or a failure set is a set
    // the plan never asked for, and printed bare among the working ones it would read as one.
    sets: day.sets
      .map((set) => (set.kind === 'working' ? setLoadLabel(set) : `${setLoadLabel(set)} ${set.kind}`))
      .join(' · '),
  }));
}

// The whole page, made once. `now` is passed rather than read so the same movement renders the same
// page in a test, and so nothing on it is a claim only the device's clock can support.
export function recordView(record, { now = Date.now() } = {}) {
  return {
    name: record.exercise.name,
    subhead: subheadOf(record),
    // A movement in the catalog nobody has ever worked draws no tiles, no chart and no lists — it
    // says that in one line instead. It has to be asked of the whole page and not of the session
    // count alone (`inTheLog` above): reading the count printed "you haven't worked this movement
    // yet" directly over the day of drop sets listed under it.
    logged: inTheLog(record),
    tiles: tilesOf(record, now),
    chart: chartOf(record, now),
    records: recordsOf(record, now),
    days: daysOf(record, now),
  };
}
