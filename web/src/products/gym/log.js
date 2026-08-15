// How a training log reads — the pure rules behind every gym surface, with no React and no fetch
// in them: which room a URL names and how each of those URLs is written, every label a number is
// printed under, and the first-performed order a session's sets are grouped in. The mirror, the
// log list, the routines and the session detail all read from here, so there is exactly one way a
// weight, a day and a duration are spelled in this product; the tests read the same rules without a
// browser.

import { round } from './logger/ladder.js';
import { inDisplayUnit, LB, weightUnit } from './units.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A position is a URL: #/gym is today, #/gym/log the log, #/gym/routines the routines,
// #/gym/movement/… one movement's record, #/gym/routines/rt_… one routine's editor,
// #/gym/session/ses_… one session, #/gym/finish/ses_… the end of the one just closed,
// #/gym/backfill the past-workout form, #/gym/proposals/prop_… one proposal read as a diff,
// #/gym/ask the chat onto the log (§L), #/gym/ask/threads its past and #/gym/ask/threads/thr_… one
// conversation read back (§O), #/gym/connect the connected log (§D12/13),
// #/gym/shared/… one workout as a coach reads it.
// Reading and writing that one grammar live together, so a link and the parse that answers it can
// never drift.
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

export const ROUTINES_HREF = '#/gym/routines';

// A routine being written for the first time stands at the same URL as one being edited, under the
// one id a mint can never produce — every real one is `rt_` and sixteen hex. So a reload lands back
// on the blank editor instead of a 404 for a routine nobody has saved yet, and the editor keeps one
// draft path for both.
export const NEW_ROUTINE_ID = 'new';

// The end of a session is a place, not a moment: the screen re-reads what the store computed, so a
// reload, a back button and a link from the log all show the same three facts.
export function finishIdOf(hash) {
  const match = /^#\/gym\/finish\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function finishHref(id) {
  return `#/gym/finish/${id}`;
}

export const BACKFILL_HREF = '#/gym/backfill';

// ASK (§L) — the chat, as a ROOM and deliberately not a fourth tab ON THIS SURFACE: web's bar is
// its three rooms, and a chat is not a place you live. The 2026-08-13 mobile boards promote Ask to
// a tab on the phones; whether web follows is an OPEN question filed to the design ledger, not one
// this file may settle. It carries no id because it is about the LOG and not about one workout,
// which is the whole difference between it and the panel it replaces.
export const ASK_HREF = '#/gym/ask';

// ASK'S PAST (§O) — the threads, and one thread read back. They hang UNDER Ask rather than beside
// it because that is what they are the past of: a lifter lands on `#/gym/ask/threads` from Ask's own
// header and from a routine's history row, and the way back from a conversation is the list.
//
// The id is `thr_` and sixteen hex from this client's own mint, but the parse takes the whole
// charset the wire allows (`^[A-Za-z0-9_-]{8,64}$`) for `proposalIdOf`'s reason: a link may have
// been written by a surface whose mint is not this one's.
export const THREADS_HREF = '#/gym/ask/threads';

export function threadIdOf(hash) {
  const match = /^#\/gym\/ask\/threads\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function threadHref(id) {
  return `#/gym/ask/threads/${id}`;
}

// THE CONNECTED LOG (§D12/13) — gym's own words around a grant the ACCOUNT owns, so it is a position
// in gym rather than a link straight out to the shell's workbench: the workbench is written for
// skill trees, and a lifter who tapped "Connected log" in their training settings asked what an
// agent may do to their TRAINING. It carries no id for the same reason Ask carries none — it is
// about the log, not about one workout.
export const CONNECT_HREF = '#/gym/connect';

// ONE PROPOSAL, READ AS A DIFF (§D14). The id is minted by whoever wrote the proposal — an agent
// over MCP — and the deep link in its receipt is this URL, so the parse has to take the whole id
// the mint's own rule allows (`prop_` and hex today, `^[A-Za-z0-9_-]{8,64}$` on the wire) rather
// than the narrower shape gym's own mints happen to have.
export function proposalIdOf(hash) {
  const match = /^#\/gym\/proposals\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function proposalHref(id) {
  return `#/gym/proposals/${id}`;
}

// A MOVEMENT'S RECORD (§H) — the page an exercise name is a door to, wherever the name appears. The
// id in it is the CATALOG's, so it is a slug for a seeded movement ('back-squat') and 'ex_<hex>'
// for one a lifter minted; both are inside the charset every other id here is read with.
export function movementIdOf(hash) {
  const match = /^#\/gym\/movement\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function recordHref(exerciseId) {
  return `#/gym/movement/${exerciseId}`;
}

// The record with no movement named yet — the picker, as a room. It is also where the retired
// statistics tab's URL lands (`screenOf` below).
export const MOVEMENTS_HREF = '#/gym/movement';

// THE ONE URL IN GYM THAT IS NOT THE LIFTER'S. The token is the whole credential — the server
// resolves it with no caller at all — so it is the only position here that means something to
// somebody with no account. The charset is the mint's: 32 bytes, base64url, unpadded (43 chars).
export function sharedTokenOf(hash) {
  const match = /^#\/gym\/shared\/([A-Za-z0-9_-]+)/.exec(hash || '');
  return match ? match[1] : null;
}

export function sharedHref(token) {
  return `#/gym/shared/${token}`;
}

// The editor is read before the list it sits under, because a routine id is also a routines URL and
// only the longer of the two is that one routine. Anything else under #/gym is Today: a hash this
// build does not know is a link from a build that did, and the home screen is where a lifter can
// get anywhere from.
//
// The coach's page is read FIRST, and not because of any ambiguity: it is the one position that
// must resolve without an account, and reading it before anything else is what keeps that fact
// visible here rather than buried in the frame.
export function screenOf(hash) {
  if (sharedTokenOf(hash)) return 'shared';
  if (sessionIdOf(hash)) return 'session';
  if (finishIdOf(hash)) return 'finish';
  if (proposalIdOf(hash)) return 'proposal';
  if (routineIdOf(hash)) return 'routine';
  if (/^#\/gym\/routines(\/|$|\?)/.test(hash || '')) return 'routines';
  if (/^#\/gym\/backfill(\/|$|\?)/.test(hash || '')) return 'backfill';
  // Ask's own past is read before Ask, longest first, exactly as a routine's editor is read before
  // the list it sits under: every threads URL is also an Ask URL, and only the longer of the two is
  // the room a lifter asked for.
  if (threadIdOf(hash)) return 'thread';
  if (/^#\/gym\/ask\/threads(\/|$|\?)/.test(hash || '')) return 'threads';
  if (/^#\/gym\/ask(\/|$|\?)/.test(hash || '')) return 'ask';
  if (/^#\/gym\/connect(\/|$|\?)/.test(hash || '')) return 'connect';
  // #/gym/stats WAS the statistics tab, and §H retires it: there is no dashboard in this product,
  // and what replaces it is one movement's page. The old URL resolves here rather than falling
  // through to Today, because somebody who kept it wanted a number about a movement and this is the
  // room that answers that — with no movement named, one tap from it.
  if (/^#\/gym\/(movement|stats)(\/|$|\?)/.test(hash || '')) return 'record';
  if (/^#\/gym\/log(\/|$|\?)/.test(hash || '')) return 'log';
  return 'today';
}

// Spelled out rather than localised: 'Tue 22 Jul' is the string the design draws, and a locale
// that reorders it would make the prefill card and the log row disagree about the same day.
export function dayLabel(ms) {
  const day = new Date(ms);
  return `${WEEKDAYS[day.getDay()]} ${day.getDate()} ${MONTHS[day.getMonth()]}`;
}

// A DAY NAMED BY ITS DATE ALONE — '27 Jul'. The record page prints it under a chart, down a list of
// personal records and beside every recent day (§H), where twelve weekday prefixes in a column are
// noise; `dayLabel` above keeps the weekday because it names ONE session, and a lifter remembers
// standing in a Tuesday. The log's bottom is the third reading — the same date, plus the year.
//
// AND ALL THREE ARE LOCAL, because every instant left in this product is one somebody stood in. A
// UTC spelling used to live here for the one that was not — a statistics week, bucketed by
// `date_trunc('week', … AT TIME ZONE 'UTC')`, which is a Monday midnight that reads as the Sunday
// evening before it west of Greenwich. That surface is retired and its weekly bars went with it.
export function shortDayLabel(ms) {
  const day = new Date(ms);
  return `${day.getDate()} ${MONTHS[day.getMonth()]}`;
}

// The day a session happened, spelled the way a lifter names the day they train on. It is the
// opening value in the name field at the finish, never a name anything writes on its own: the field
// is on screen, it is typed over, and no routine exists until Save is tapped.
export function weekdayName(ms) {
  return WEEKDAY_NAMES[new Date(ms).getDay()];
}

export function timeLabel(ms) {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

// The bottom of the log, and it is a date rather than an empty box (§G16): a lifter who has just
// imported years of training reads this list to find out whether all of it came across, and the day
// they started is the one fact worth arriving at. The year is spelled here and nowhere else —
// everywhere else in gym is a day inside the last few months, where a year is noise.
export function firstSessionLabel(ms) {
  return `first session · ${shortDayLabel(ms)} ${new Date(ms).getFullYear()}`;
}

export function whenLabel(ms) {
  return `${dayLabel(ms)} · ${timeLabel(ms)}`;
}

// WHEN A PROPOSAL ARRIVED — canon §D14's `Sun 21:14`, which is the weekday and the hour because a
// lifter reading a diff on Monday morning remembers the Sunday evening they asked for it. The
// weekday alone repeats every seven days, so past a week it takes the date instead: a card that
// waited a fortnight must not say `Sun` and let the reader supply the wrong Sunday. Six days is the
// cut rather than seven, because a Sunday and the Sunday before it are the two that would collide.
const WEEKDAY_MS = 6 * 86400000;

export function arrivedLabel(ms, now = Date.now()) {
  if (now - ms >= WEEKDAY_MS) return whenLabel(ms);
  return `${WEEKDAYS[new Date(ms).getDay()]} ${timeLabel(ms)}`;
}

// A session read whole says when it ran, how long it took and how much is in it — the day itself
// is the title above this line, so it is never printed twice. An open session gets no end time
// invented for it.
export function sessionMetaLabel(session, setCount) {
  const started = timeLabel(session.startedAt);
  if (!isFinished(session)) return `${started}   ·   in progress   ·   ${setCountLabel(setCount)}`;
  const length = durLabel(session.finishedAt - session.startedAt);
  return `${started}–${timeLabel(session.finishedAt)}   ·   ${length}   ·   ${setCountLabel(setCount)}`;
}

// WHEN, ON A LOG ROW (§G16). A session from today is named by its clock, because the day is the one
// thing every row on the screen would otherwise share; every older one is named by its day, because
// by then the hour is not what a lifter is looking for. The calendar-day rule is agoLabel's own — a
// session finished at 07:00 is still today at 21:00 — so both spellings agree about which day it is.
//
// A session nobody has ended says so. It is the phone's workout, mirrored (§11.2), and its counts
// are what has been logged so far rather than what the session will hold.
export function logWhenLabel(session, now = Date.now()) {
  const when = agoLabel(session.startedAt, now) === 'today'
    ? `today · ${timeLabel(session.startedAt)}`
    : dayLabel(session.startedAt);
  if (!isFinished(session)) return `${when} · in progress`;
  return when;
}

// "Yesterday" is a claim about the calendar, not about elapsed hours: a session finished at 07:00
// is still today at 21:00, and one finished at 23:00 is already yesterday by 01:00. So both
// instants fall back to their own local midnight before the difference is taken — which also makes
// the count right across a 23- and a 25-hour day, where dividing by 86400000 is not.
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

// The session clock and the rest timer both read this, and both hand it an elapsed span computed
// from an instant — never a counter they incremented. A backgrounded tab, a locked phone and a
// full reload therefore all come back showing the true elapsed time.
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

// The empty bar — the value a form opens on when it has nothing better to go on: a backfill line
// just added, a routine target not yet typed. It is a number on screen to be typed over, never a
// guess at a weight anybody lifted. (The live prefill — sticky carry-forward, plan, last time —
// lives on the phones now, beside the capture it serves.)
export const EMPTY_BAR_KG = 20;
export const EMPTY_BAR_REPS = 5;

// Weights print with trailing zeros stripped and a real U+2212 minus, because a negative load is
// a normal point on the number line here — band-assisted work sits below zero.
// The grid is the ladder's, not a second opinion: this read the magnitude to two decimals itself
// until the two spellings disagreed on a negative half-cent, and one of them has a golden.
//
// AND IT IS WHERE UNITS HAPPEN, once, for the whole surface (units.js). Every printed weight in gym
// comes through here, so the account reading in pounds reads in pounds everywhere at the cost of one
// call — and the value that went into the store is the value that came out of it, untouched.
export function fmt(weightKg) {
  const shown = inDisplayUnit(weightKg);
  return (shown < 0 ? '−' : '') + String(Math.abs(round(shown)));
}

// THE KILOGRAM SPELLING, for the four places on this desk where a number is not a reading but a
// FIELD: the backfill's line, the correction sheet, a routine's target and the keypad's own message.
// Each of them is typed into and lands in the log exactly as it stands — the transform above may
// never touch a value on its way to a write — so each says `kg` on its face whatever the account
// reads in, and the Units row says that out loud rather than leaving it to be discovered.
export function fmtKg(weightKg) {
  return (weightKg < 0 ? '−' : '') + String(Math.abs(round(weightKg)));
}

// AND THE SENTENCE THAT RECONCILES THE TWO, because the field and the reading of the same weight are
// on screen together and under an account reading in pounds they are two different numerals: the
// target sheet stands over the routine's own rows, the correction sheet over the session's. `100 kg`
// above `220.5` looks like two weights, and a lifter has no way to know they are one — this is the
// line that says they are. Null in kilograms, where there is nothing to reconcile and an extra
// sentence would only be noise on a field that already agrees with everything around it.
export function alsoReadsLabel(weightKg) {
  if (weightKg == null || weightUnit() !== LB) return null;
  return `reads ${fmt(weightKg)} ${LB} in your log`;
}

export function setCountLabel(count) {
  return count === 1 ? '1 set' : `${count} sets`;
}

// THE FOUR FACTS §G16 SCANS FOR, spelled once each. `setCountLabel` above counts every set of every
// kind and has its own consumers; a log row counts WORKING sets, because that is the word for what
// counts in this product and the top set beside it was already picked under the same rule.
export function workingLabel(count) {
  return `${count} working`;
}

// The estimate, and the web computes none of it: `topE1rm` is the domain's best Epley over EVERY
// working set the session held — not the estimate over its heaviest one — carried on the wire
// (gymApi.js). There is one copy of that formula per language and this is not one of them
// (review.js); a second opinion drawn here would be the product arguing with itself in its own
// loudest pixel, and it would disagree with the finish screen, which comes through the same rule.
export function e1rmLabel(topE1rm) {
  if (topE1rm == null) return null;
  return `e1RM ${fmt(topE1rm)}`;
}

// TONNAGE IS A CAPTION AND NEVER A METRIC. The domain refuses volume brand-wide (domain/
// Statistics.h) for a good reason — four light sets must not outrank three heavy ones — and that
// refusal stands: e1RM is the headline everywhere. What this is, is the scale of a week sitting on
// a divider, and the scale of one session in its header.
//
// AN ASSISTED SET CONTRIBUTES ZERO. A band takes load off the bar, so its negative load moved no
// external weight; bodyweight work is zero for the same reason, and gym does not know a lifter's
// bodyweight. So the sum clamps at zero rather than subtracting.
//
// Two sources, one rule, exactly as the top set has. A session in the LIST carries the store's own
// aggregation under `tonnageKg`, because the list carries no sets; a session read whole carries the
// sets and the sum is made here.
export function tonnageOf(session, sets = null) {
  if (typeof session?.tonnageKg === 'number') return session.tonnageKg;
  if (sets == null) return null;
  return workingSetsOf(sets).reduce((total, set) => total + Math.max(set.weightKg, 0) * set.reps, 0);
}

// AND A ZERO TONNAGE SAYS NOTHING AT ALL. A chin-up-and-dips week did not move zero kilograms; we
// simply have nothing true to say about its scale, and absence beats a false zero.
//
// UNDER A TONNE THE FIGURE IS SPELLED IN KILOGRAMS, and the threshold is the tonne itself rather
// than wherever `toFixed(1)` happens to stop producing `0.0`. One decimal of a tonne cannot hold a
// small number: `0.1 t` for 51 kg is not a rounding, it is double, and a divider that doubles a
// beginner's week is the same false number the zero would have been. Above a tonne the decimal is
// worth a hundred kilograms, which is the scale the caption is a caption OF.
//
// THE SCALE WORD FOLLOWS THE READING. A tonne is what a metric reader calls a week of training; a
// pound reader has no such word, so the same physical threshold prints thousands of pounds rather
// than a unit they never use. The threshold itself is the mass and not the numeral, so the two
// readings switch scale on the same week.
export function tonnageLabel(kg) {
  if (kg == null || kg <= 0) return null;
  if (kg < 1000) return `${fmt(kg)} ${weightUnit()}`;
  if (weightUnit() === LB) return `${(inDisplayUnit(kg) / 1000).toFixed(1)}k lb`;
  return `${(kg / 1000).toFixed(1)} t`;
}

// THE HEAD OF THE LOG. Both numbers are of what is IN HAND — the log carries no total, and a page
// short of the one asked for is the only signal there is that the bottom has been reached — so
// "loaded" is not decoration on the sentence: it is what makes it true while there is more.
export function loadedLine(sessions, weeks) {
  const list = sessions === 1 ? '1 session' : `${sessions} sessions`;
  const span = weeks === 1 ? '1 week' : `${weeks} weeks`;
  return `${list} · ${span} loaded`;
}

// WEEKS ARE A FOLD OVER THE PAGE IN HAND, not a read: there is no week endpoint, and the log
// arrives newest-first in one order the server guarantees, so a week is a run of adjacent rows.
// They start Monday and they start in the lifter's own zone, because a session is an instant
// somebody stood in — which is now the only kind of instant left in this product.
//
// THE OLDEST LOADED WEEK KEEPS ITS TONNAGE TO ITSELF. It is the one week `Load older` can still add
// sessions to, so its sum is a floor rather than a fact — and a divider understating a week is the
// same false number a zero would be. Once the log has reached its end nothing can be added to it,
// and the week is whole.
export function weeksOf(summaries, { complete = false } = {}) {
  const weeks = [];
  for (const summary of summaries) {
    // THE ARITHMETIC RUNS AT NOON AND THE MONDAY IS REBUILT FROM THE DATE IT LANDS ON, because the
    // instant is this fold's EQUALITY KEY. A zone whose clocks jump at local midnight — Santiago,
    // Havana, Beirut — has no 00:00 at all on the transition day: `setHours(0, …)` lands on 01:00
    // there and `setDate` carries that hour back to the Monday, so two sessions of one week answer
    // two different instants, the week splits into two dividers and each carries a tonnage the week
    // never moved. Noon exists on every day in every zone, and rebuilding from the calendar date
    // leaves no hour that could have leaked in from one session's own day. (`agoLabel` uses the
    // midnight idiom safely: it DIFFERENCES two of them, and this compares them.)
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
    // A row from a deployment that does not aggregate tonnage yet leaves the week unsummable, and
    // summing the rest would understate it exactly as a partial week does.
    const unknown = week.sessions.some((session) => typeof session.tonnageKg !== 'number');
    if (partial || unknown) return { ...week, tonnage: null };
    const kg = week.sessions.reduce((total, session) => total + session.tonnageKg, 0);
    return { ...week, tonnage: tonnageLabel(kg) };
  });
}

// A HOLLOW RING MEANS THIS SESSION IS SAVED ON THIS DEVICE ONLY — the state this surface can never
// be in: the web holds nothing locally, so no read here sets it and no row ever wears one. It is
// asked for anyway, because a row that cannot express the state is a row that will be wrong the day
// the desk gets a queue of its own.
//
// IT IS NOT A WIRE FIELD AND NO SERVER SENDS ONE. Each surface decides it from the queue it is
// holding — iOS off `LogWeeks.Row.deviceOnly` (LogScreen.swift), Android off
// `LogFold.Row.onThisDeviceOnly` (LogScreen.kt), both fed by the ids their own store has not
// flushed yet. So `summary.onThisDevice` is where the desk will write its own answer when it has a
// queue, not a name a read fills in, and the ink is the one both phones already wear
// (`unsyncedInk`, GymSkin.swift / GymSkin.kt — `--unsynced-ink` here).
export function onThisDevice(session) {
  return session?.onThisDevice === true;
}

// A GOLD DOT MEANS A PR HAPPENED IN THERE (§G16), and the store decides which sessions those are:
// the three record rules — best e1RM, most reps at a load, heaviest load — walked over the log's
// working sets in order (backend domain/Review.h). Nothing on this surface re-derives one.
//
// IT IS JUDGED AGAINST THE LOG AS IT IS NOW, never frozen at the finish — which is load-bearing
// since §G18: a correction moves records, and the log is re-read the moment one lands (Log.jsx),
// because a dot that went on lying after a fix would be worse than no dot at all. The field is
// always sent, so a row from a deployment that does not send it wears nothing rather than claiming
// the session earned nothing — which is why this asks for the true and not for the absence of false.
export function hasRecord(session) {
  return session?.record === true;
}

// A ROUTINE NOBODY HAS TRAINED YET, and there is no field for it: `lastTrainedAt` is the store's
// aggregate over the log, so its absence IS the state and nothing else spells it (gymApi.js). The
// word is canon's — `untested`, because the routine is a bet nobody has taken yet, which is exactly
// why the first session is allowed to disagree with it (§M).
export const UNTESTED = 'untested';

export function isUntested(routine) {
  return routine?.lastTrainedAt == null;
}

// A routine row says what it holds and when it was last used, because that is how a lifter picks
// one — and it is the same fact the list is sorted by, so the row never has to explain its own
// order. A routine nobody has trained yet says exactly that rather than borrowing today.
export function routineMetaLabel(routine, now = Date.now()) {
  const count = routine.entries?.length ?? 0;
  const movements = count === 1 ? '1 movement' : `${count} movements`;
  if (isUntested(routine)) return `${movements} · ${UNTESTED}`;
  return `${movements} · trained ${agoLabel(routine.lastTrainedAt, now)}`;
}

// WHAT WEIGHT A PLAN ASKED FOR, OR NOTHING AT ALL — and this is the ONE place that question is
// answered, because a target read two ways is a screen whose exercise header says the plan named no
// weight while a set under it says the lifter went 5 kg over it. "No target" has two spellings on
// the wire — the field omitted, and a zero — and gym writes the second itself: `routineFromSession`
// takes the heaviest load of a movement, which is 0 for a session of chin-ups, and the routine write
// only drops a target that is null. Zero is not a load, it is the absence of one. A band-assisted
// −20 IS a target: it is a real point on this number line.
export function targetLoadOf(weightKg) {
  if (weightKg == null || weightKg === 0) return null;
  return round(weightKg);
}

// THE LINE THAT ASKS FOR NOTHING (§M). A routine is savable while incomplete: an entry with no set
// target is OPEN, and an open line simply asks at the rack. The absence of `targetSets` is the whole
// of that state — there is no flag and no zero, and the wire refuses an open line that still names
// reps or a weight — so this word is read off one missing field and can say nothing else.
export const OPEN_TARGET = 'open';

// What a routine asks a movement for, in one line: the editor's row, Today's preview of the routine
// due next, and the finish screen's offer all print it, so a target reads the same wherever it is
// read. An absent weight is "whatever you did last time" and prints nothing, by the rule above.
//
// An absent REP target is canon screen 6's `3 × max` — a movement taken to whatever it gives that
// day. It is not a zero and it is not a blank, and the wire spells it by omission (gymApi.js).
export function entryLabel(entry) {
  if (entry.targetSets == null) return OPEN_TARGET;
  const reps = entry.targetReps ?? 'max';
  const target = targetLoadOf(entry.targetWeightKg);
  if (target == null) return `${entry.targetSets} × ${reps}`;
  return `${entry.targetSets} × ${reps} · ${fmt(target)}`;
}

// ONE WORD FOR WHAT COUNTS. A set counts toward a target, a plan counter, a record and the number
// under the thumb only when its kind is `working` — the kinds are warmup · working · drop · failure,
// and the last three are all things that happened to a set the plan never asked for. The domain's
// record rules read the same word, so a drop must not advance "set 4 of 5" here while counting
// toward nothing there. The movement is optional because a session's sets are sometimes already
// one movement's.
export function workingSetsOf(sets, exerciseId = null) {
  return sets.filter((set) => (
    set.kind === 'working' && (exerciseId == null || set.exerciseId === exerciseId)
  ));
}

// The heaviest WORKING set of a session — what a movement's line is measured on everywhere in this
// product: never volume, because four light sets must not beat three heavy ones. A tie goes to the
// set that got more reps at the same load.
//
// It is also what the log row's e1RM is the estimate OF. The row draws the estimate now (§G16) and
// the coach's shared page still draws the set itself, which is the whole difference between them:
// a page with no account behind it gets the fact, not a formula's reading of it.
//
// Two sources, one rule. A session in the LIST carries the store's own pick under `topSet`
// (gymApi.js), because the list carries no sets; a session read whole carries the sets and the pick
// is made here. Both answer `{weightKg, reps}` or nothing at all.
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

// A movement is a stable id everywhere except on screen, where it is the catalog's display name.
// Falling back to the id keeps a sentence readable when the catalog hasn't answered yet — a slug
// a lifter can still recognise beats a blank where the movement should be.
export function movementOf(catalog, exerciseId) {
  return catalog?.find((exercise) => exercise.id === exerciseId) ?? null;
}

export function nameOfMovement(catalog, exerciseId) {
  return movementOf(catalog, exerciseId)?.name ?? exerciseId;
}

// WHAT A LIFTER MAY TYPE INTO A NAME — a routine's and a movement's alike, because it is one
// question asked on four surfaces and two ceilings would be two things to keep true. The store's
// own ceiling is EIGHTY BYTES and this is deliberately tighter: a field bound under the column's
// costs nothing, while a name typed to the column's edge would be refused in a language whose
// letters are three bytes each. Sixty is the number the counter on screen says out loud (§N).
//
// It counts UTF-16 units because that is what `maxLength` counts, and a counter that disagreed with
// the field it sits under would run past 60 and stop, or stop before it. Sixty EMOJI are still
// refused by the store, in the product's own voice — no client rule can make that case land, and
// none here pretends to: the cap is a length, and §N allows any language, spelling and punctuation.
export const NAME_MAX = 60;

export function nameCountLabel(typed) {
  return `${(typed ?? '').length}/${NAME_MAX}`;
}

// AND A NAME CAN ARRIVE OVER IT WITHOUT ANYONE TYPING PAST IT. `maxLength` stops a key and a paste,
// but every field that asks for a name OPENS ON ONE — the movement's own, out of a store that keeps
// eighty, or the search box's query, which caps nothing — so a movement an agent minted with seventy
// characters opens the rename field reading `70/60`. That count is true and stays true; this is the
// flag the counter wears so a field that has quietly stopped accepting keys has said why.
export function isNameOverCap(typed) {
  return (typed ?? '').length > NAME_MAX;
}

// A session is over when the server says it has an end instant — and only then. Zero is an
// instant like any other, so this asks for absence rather than truthiness.
export function isFinished(session) {
  return session.finishedAt != null;
}

// "Your first session" is the log's claim and never the review's: the store answers what happened
// inside one session and cannot see the list. One other FINISHED session is all it takes to refute
// it, and the log reads newest first — so the two newest rows settle it, and the session being asked
// about is excluded because it is one of them.
export function isFirstSession(sessions, id) {
  return !sessions.some((session) => session.id !== id && isFinished(session));
}

// A session nobody ended. The four-hour close stamps the end AT the last set — and at the start
// instant when there was never one (backend §3.2) — while a Finish is stamped at the tap, which
// happens after the set it follows and after a round trip. So an end that is not later than the
// last thing that happened is an end nobody pressed, and that is the whole of the fingerprint.
//
// Two sources, one rule, exactly as the top set has. A session in the LIST carries the store's own
// answer under `closedItself`, which is that same fingerprint read where the sets are; a session
// read whole carries the sets and the fingerprint is read here.
export const CLOSED_ITSELF_NOTE = 'closed on its own — no set for four hours';

export function closedOnItsOwn(session, sets = null) {
  if (typeof session?.closedItself === 'boolean') return session.closedItself;
  if (!isFinished(session)) return false;
  if (sets == null) return false;
  if (sets.length === 0) return session.finishedAt === session.startedAt;
  return session.finishedAt === Math.max(...sets.map((set) => set.completedAt));
}

// The plan is the snapshot frozen at session start — a session from two weeks ago still reads
// against the target it actually had. The wire may carry it already parsed or as the stored json
// string, and both mean the same thing, so every surface asks this one question rather than
// re-deciding what a plan looks like.
export function planOf(session) {
  const plan = session?.plan;
  if (!plan) return null;
  if (typeof plan !== 'string') return plan;
  try { return JSON.parse(plan); } catch { return null; }
}

// A session read whole, in one line (§G17): the day, how long it took, and the two facts the header
// is measured in. The routine is the title above this line, so it is never printed twice — the same
// rule that keeps the day out of `sessionMetaLabel`. An open session gets no length invented for it.
export function sessionDetailMeta(session, sets) {
  const parts = [dayLabel(session.startedAt)];
  if (isFinished(session)) parts.push(durLabel(session.finishedAt - session.startedAt));
  else parts.push('in progress');
  parts.push(workingLabel(workingSetsOf(sets).length));
  const tonnage = tonnageLabel(tonnageOf(session, sets));
  if (tonnage) parts.push(tonnage);
  return parts.join(' · ');
}

// The chip that names the snapshot the section below is read against. The instant is the session's
// START, because that is when the plan was frozen (backend TrainingService) — a routine renamed or
// retargeted since must not rewrite what the log says about the past, and this line is what says
// out loud that it cannot. A session with no snapshot has no chip and no comparison to draw.
export function planFrozenLabel(session) {
  if (!planOf(session)) return null;
  return `plan snapshot · frozen ${timeLabel(session.startedAt)}`;
}

export const NOT_IN_PLAN = 'not in the plan';

// WHAT THE PLAN SAID ABOUT ONE MOVEMENT — read off the frozen snapshot and never off today's
// routine, which is the whole reason the snapshot exists. A snapshot entry names its fields the
// way the domain does (`sets` · `reps` · `weightKg`, TrainingJson.cpp) while a routine entry names
// them `target…`, so this is where the two vocabularies meet; the target is spelled by the one
// function that spells every target in this product, so the log and the editor cannot drift.
//
// ⚠ A PLAN MAY NAME ONE MOVEMENT TWICE — the heavy line and the back-off line — and `PlanEntry`
// carries no id, so nothing here can tell which of the two a logged set was performed against.
// That case answers `ambiguous`: no target on the header and no note on any set. Guessing would
// label half of them against the wrong line, and a wrong annotation is worse than none.
export function planReadingOf(session, exerciseId) {
  // The snapshot is frozen jsonb the server echoes back verbatim, so a list of entries is only a
  // convention — the same reason `routineNameOf` below asks whether the routine is a string, and
  // `?? []` would not catch a plan that is itself an array, whose `.entries` is a function. A plan
  // nothing can be read out of has no comparison to draw, exactly like a session that had none; an
  // EMPTY list is a different fact, and it does mean every movement was added today.
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

// A SMALL COUNT, SPELLED — "two short" on a set, "All four or none" under a proposal. Spelled out
// to ten, because "two short" is a sentence and "2 short" is a score; past ten the word stops being
// one a lifter would say and the numeral is what is left. ONE table for the product: two of them
// would disagree the first day either grew, and both sentences are read on the same surface.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

export function numberWord(count) {
  return NUMBER_WORDS[count] ?? String(count);
}

// THE ONE THING WORTH SAYING ABOUT A SET, beside what it was. Dim is what the plan said, bright is
// what you did, and a miss gets one line and no scolding (§G17) — which is why there is no note for
// a lighter bar: the plan is what was agreed to, not a score to fall below.
//
// A set that is not `working` says only its own kind. Warmup, drop and failure are all sets the
// plan never asked for — the same word for what counts that `workingSetsOf` reads — so none of them
// is measured against a target.
//
// SHORT ONLY WHEN THE BAR DID NOT GO UP. Heavier for fewer is a different session rather than a
// smaller one, and calling it short would grade a lifter for a choice they made on purpose. This is
// review.js's rule for the same comparison, said once more where the sets are.
export function setNoteOf(set, reading, first) {
  if (set.kind !== 'working') return set.kind;
  if (reading.kind === 'added') return first ? 'added today' : null;
  if (reading.kind !== 'planned') return null;
  const { reps, weightKg } = reading.entry;
  // The same reading of the target the exercise header above these sets printed (`entryLabel`), and
  // it has to be: a plan that named no weight can be neither gone over nor met.
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

// Zero is not a load, it is the absence of one — the rule `entryLabel` already reads a target by —
// so a set logged at nothing is the movement done at bodyweight. A band-assisted −20 prints its
// load, being a real point on this number line.
export function setLoadLabel(set) {
  if (set.weightKg === 0) return `bodyweight × ${set.reps}`;
  return `${fmt(set.weightKg)} × ${set.reps}`;
}

// ONE WORD FOR A SESSION NOBODY PLANNED, everywhere it is named: the log row, the session read
// whole, the review subtitle, the overlap panel and the mirror's head. It is the phrase the design
// board names a session by on every screen that has to (§G16's row, the between-sets header, the
// first session), which is why "Ad-hoc" and then the bare "No routine" were each retired for the
// same session. Nothing dims it: most rows in most logs will not have a routine, and the phrase
// itself is what keeps it from reading as a fault.
export const NO_ROUTINE = 'Session · no routine';

export function routineNameOf(session) {
  // The snapshot is frozen jsonb the server echoes back verbatim, so `routine` is only a name by
  // convention — anything else React would throw on as a child. A non-string is no routine.
  const routine = planOf(session)?.routine;
  return typeof routine === 'string' && routine !== '' ? routine : null;
}

// First-performed order falls out of Map insertion order over sets sorted by completion; inside an
// exercise the server-assigned number is the order. A set the server has not numbered yet is one a
// capture surface is still flushing — it is the newest thing in that exercise, so it sorts last,
// and two of them fall back to when they happened. Without that floor the comparator returns NaN
// and the order of a session being logged is whatever the sort implementation happens to do.
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
