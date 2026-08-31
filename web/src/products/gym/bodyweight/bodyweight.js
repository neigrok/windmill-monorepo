// The pure rules behind a weigh-in: the reading at the head of the log, the field's refusals, the
// write the wire takes, the chart's window and its words. One row per local calendar date, the date
// IS the identity, kilograms on the wire, the display unit on the screen. Nothing here trends,
// projects or grades a series: the chart draws the numbers the lifter typed and no others.

import { agoLabel, shortDayLabel } from '../log.js';
import { fromDisplayUnit, inDisplayUnit, LB, weightUnit } from '../units.js';

export const BODYWEIGHT_TITLE = 'Bodyweight';
export const WEIGH_IN_VERB = 'Weigh in';
export const DATE_LABEL = 'Date';
export const SAVE_VERB = 'Save';
export const DECIMAL_HINT = 'comma or point, both read as a decimal';
export const NO_WEIGH_INS = 'No weigh-ins yet.';
export const NO_WEIGH_INS_LINE = 'Weigh in from the log and the number lands here.';
export const NO_WEIGH_INS_IN_WINDOW = 'No weigh-in in the last 90 days.';
export const OPENING = 'Opening your weigh-ins…';
export const FAILED = 'Your weigh-ins didn’t load.';

export const DELETE_VERB = 'Delete weigh-in';

// One press, and the way back is the window's Undo rather than a question in front of the act.
export const WEIGH_IN_DELETED = 'Weigh-in deleted.';

// Kilograms, the same numbers the store's CHECK holds.
export const MIN_KG = 20;
export const MAX_KG = 400;

export const REFUSALS = {
  notNumber: 'That is not a number yet.',
  decimals: 'One decimal point only.',
  bounds: 'Between 20 and 400 kg — check the number.',
  future: 'A weigh-in is not a forecast — today or earlier.',
};

// A segment joins two dots only when they are at most this many calendar days apart; a missed week
// breaks it. Calendar days, not elapsed hours: the dots sit on local midnights, and a week of those
// runs 167 or 169 hours across a clock change.
export const GAP_DAYS = 7;
export const GAP_RULE = 'no line is drawn across a gap longer than seven days';

export function joinsAcross(from, to) {
  return Math.round((to.at - from.at) / 86400000) <= GAP_DAYS;
}

// `label` is the control's word; `stated` is how the chart prints the window it shows.
export const WINDOWS = [
  { id: '90', label: '90 days', days: 90, stated: 'last 90 days' },
  { id: 'all', label: 'All', days: null, stated: 'the whole series' },
];
export const DEFAULT_WINDOW = '90';

const DATE_LOCAL = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad2 = (value) => String(value).padStart(2, '0');

// The lifter's own calendar date, in their zone; never UTC, which would move a late weigh-in to tomorrow.
export function dateLocalOf(ms) {
  const day = new Date(ms);
  return `${day.getFullYear()}-${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}`;
}

// Local midnight of a `YYYY-MM-DD`; null for anything that is not a real date.
export function msOfDateLocal(dateLocal) {
  const match = DATE_LOCAL.exec(dateLocal ?? '');
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const at = new Date(year, month - 1, day);
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day) return null;
  return at.getTime();
}

// The number in the display unit: kilograms to the two decimals the wire carries, trailing zeros
// dropped; pounds to a tenth (units.js). Never rounded past what was typed.
export function weightReading(weightKg) {
  const shown = inDisplayUnit(weightKg);
  if (weightUnit() === LB) return String(shown);
  return String(Math.round(shown * 100) / 100);
}

// `82.4 kg · 3 days ago`. Null with no weigh-in: the head then draws nothing, not a dash.
export function readingLine(latest, now = Date.now()) {
  if (!latest) return null;
  const at = msOfDateLocal(latest.dateLocal);
  if (at == null) return null;
  return `${weightReading(latest.weightKg)} ${weightUnit()} · ${agoLabel(at, now)}`;
}

// The field takes comma or point; the refusals come one at a time, in this order.
export function parseWeighIn(text) {
  const raw = (text ?? '').trim();
  const normalised = raw.replace(/,/g, '.');
  if ((normalised.match(/\./g) || []).length > 1) return { valid: false, message: REFUSALS.decimals };
  if (raw === '' || !/^\d*\.?\d*$/.test(normalised) || !/\d/.test(normalised)) {
    return { valid: false, message: REFUSALS.notNumber };
  }
  const weightKg = fromDisplayUnit(Number(normalised));
  if (weightKg < MIN_KG || weightKg > MAX_KG) return { valid: false, message: REFUSALS.bounds };
  return { valid: true, weightKg };
}

// `recordedAt` is the device's clock at the moment of saving: it decides only which of two writes
// for one date is the newer, and supports no claim on a screen. The same clock names the device's
// local today, which is the latest date a weigh-in can carry — `YYYY-MM-DD` orders as text.
export function weighInWrite(text, dateLocal, now = Date.now()) {
  const parsed = parseWeighIn(text);
  if (!parsed.valid) return { refusal: parsed.message };
  if (msOfDateLocal(dateLocal) == null) return { refusal: 'could not read that date' };
  if (dateLocal > dateLocalOf(now)) return { refusal: REFUSALS.future };
  return { dateLocal, weightKg: parsed.weightKg, recordedAt: now };
}

export function fieldValueOf(weightKg) {
  return weightReading(weightKg);
}

// The read with this screen's own writes folded over it: `moves` is date → the stored row, or null
// for a deleted one. Ascending by date, one row per date, so a write that landed before the read
// answered is not lost when it does.
export function entriesAfter(entries, moves) {
  const byDate = new Map((entries ?? []).map((entry) => [entry.dateLocal, entry]));
  for (const [dateLocal, entry] of moves ?? []) {
    if (entry == null) byDate.delete(dateLocal);
    else byDate.set(dateLocal, entry);
  }
  return [...byDate.values()].sort((a, b) => (a.dateLocal < b.dateLocal ? -1 : 1));
}

// The newest row up to the device's local today. A served row dated after it is never the reading:
// a weigh-in is not a forecast, whatever clock wrote it.
export function latestOf(entries, now = Date.now()) {
  const today = dateLocalOf(now);
  const past = (entries ?? []).filter((entry) => entry.dateLocal <= today);
  if (past.length === 0) return null;
  return past[past.length - 1];
}

export function windowById(id) {
  return WINDOWS.find((window) => window.id === id) ?? WINDOWS[0];
}

// The window's first day: today and the 89 days before it, or the whole series.
export function windowStartOf(windowId, now = Date.now()) {
  const window = windowById(windowId);
  if (window.days == null) return null;
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - (window.days - 1));
  return day.getTime();
}

// The rows the chart draws: those in the window, and never one dated after the device's local today.
export function windowOf(entries, windowId, now = Date.now()) {
  const start = windowStartOf(windowId, now);
  const today = dateLocalOf(now);
  return (entries ?? []).filter((entry) => {
    const at = msOfDateLocal(entry.dateLocal);
    if (at == null || entry.dateLocal > today) return false;
    return start == null || at >= start;
  });
}

// The x-range the chart states: the window's first day to today, or the series' first day to today,
// so the days since the last weigh-in are visibly empty rather than cut off at the last dot.
export function chartDomainOf(entries, windowId, now = Date.now()) {
  const today = msOfDateLocal(dateLocalOf(now));
  const start = windowStartOf(windowId, now) ?? msOfDateLocal(entries?.[0]?.dateLocal) ?? today;
  return { from: start, to: today };
}

// One dot per row, in the display unit, each carrying the words a reader or a screen reader gets.
export function chartPointsOf(entries) {
  return (entries ?? []).map((entry) => ({
    key: entry.dateLocal,
    at: msOfDateLocal(entry.dateLocal),
    value: inDisplayUnit(entry.weightKg),
    label: `${weightReading(entry.weightKg)} ${weightUnit()} · ${shortDayLabel(msOfDateLocal(entry.dateLocal))}`,
    dateLocal: entry.dateLocal,
  })).filter((point) => point.at != null);
}

// `no weigh-in · 7 Jul – 4 Aug`: the last dot before the gap and the first after it.
export function gapLabel(from, to) {
  return `no weigh-in · ${shortDayLabel(from.at)} – ${shortDayLabel(to.at)}`;
}

// `last 90 days · 3 weigh-ins`: the window the chart shows and how many dots are in it.
export function chartCaption(windowId, count) {
  const counted = count === 1 ? '1 weigh-in' : `${count} weigh-ins`;
  return `${windowById(windowId).stated} · ${counted}`;
}

// The unit lives on the axis, in the display unit the dots are in.
export function axisValue(value) {
  return `${Math.round(value * 10) / 10} ${weightUnit()}`;
}

export function axisDate(ms) {
  return shortDayLabel(ms);
}

// Save was refused: the store's sentence where it sent one, the wordless fallback otherwise.
export function saveRefusal(error) {
  if (typeof error?.detail === 'string' && error.detail !== '') return error.detail;
  if (error?.status === 401) return 'You’re signed out. Sign in and try again.';
  return 'That weigh-in wasn’t saved — the log didn’t answer. Try again when you have signal.';
}

export const DELETE_FAILED = 'That weigh-in wasn’t deleted. Try again in a moment.';

export const EXPORT_BODYWEIGHT_VERB = 'Export weigh-ins';
export const EXPORT_BODYWEIGHT_LINE = 'every weigh-in as CSV · yours, always';
