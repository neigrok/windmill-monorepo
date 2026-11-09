// The day stamps the journal draws, from ISO days only — the server sends nothing else. A distance is a
// bare span, always measured from the trigger page's day, never from today.

import { t } from '../i18n/index.js';

const WEEKDAYS = [
  t('journal.date.weekday.sun'), t('journal.date.weekday.mon'), t('journal.date.weekday.tue'),
  t('journal.date.weekday.wed'), t('journal.date.weekday.thu'), t('journal.date.weekday.fri'),
  t('journal.date.weekday.sat'),
];

export const SHORT_MONTHS = [
  t('journal.date.month.jan'), t('journal.date.month.feb'), t('journal.date.month.mar'),
  t('journal.date.month.apr'), t('journal.date.month.may'), t('journal.date.month.jun'),
  t('journal.date.month.jul'), t('journal.date.month.aug'), t('journal.date.month.sep'),
  t('journal.date.month.oct'), t('journal.date.month.nov'), t('journal.date.month.dec'),
];

function parts(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// FRI 29 AUG — the canvas day row, the margin's stamp naming the page the panel describes, and a search
// hit's date. They are the same glyph run on purpose: the reader matches the panel to the canvas by
// shape before reading either, so this format has one grammar. Today is not special here —
// the stamp is a COPY of the row it points at, never `TONIGHT`, which is a destination and not a mirror.
export function stampWeekday(iso) {
  const { year, month, day } = parts(iso);
  return t('journal.date.stampWeekday', {
    weekday: WEEKDAYS[new Date(year, month - 1, day).getDay()], day: pad(day), month: SHORT_MONTHS[month - 1],
  });
}

// "14 MAR" / "2026" — the two lines of the ink's margin column.
export function stampStacked(iso) {
  const { year, month, day } = parts(iso);
  return { head: t('journal.date.stampDay', { day: pad(day), month: SHORT_MONTHS[month - 1] }), year: String(year) };
}

// 02 NOV 25 — the run of other dates, where the column is narrow.
export function stampCompact(iso) {
  const { year, month, day } = parts(iso);
  return t('journal.date.stampCompact', { day: pad(day), month: SHORT_MONTHS[month - 1], year: String(year).slice(-2) });
}

// 14 MAR 2026 — a trail chip.
export function stampPlain(iso) {
  const { year, month, day } = parts(iso);
  return t('journal.date.stampPlain', { day: pad(day), month: SHORT_MONTHS[month - 1], year });
}

// Months between two days, older first, to the nearest month. Rounding is on the calendar, not on an
// average month, and runs from zero, so a 30-day reach is one month rather than none.
export function monthsApart(olderIso, newerIso) {
  const older = parts(olderIso);
  const newer = parts(newerIso);
  const whole = (newer.year - older.year) * 12 + (newer.month - older.month) - (newer.day < older.day ? 1 : 0);
  if (whole < 0) return 0;
  const anchor = Date.UTC(older.year, older.month - 1 + whole, older.day);
  const nextAnchor = Date.UTC(older.year, older.month - 1 + whole + 1, older.day);
  const leftover = Date.UTC(newer.year, newer.month - 1, newer.day) - anchor;
  return whole + (leftover * 2 >= nextAnchor - anchor ? 1 : 0);
}

function weeksApart(olderIso, newerIso) {
  const older = parts(olderIso);
  const newer = parts(newerIso);
  const days = Math.round((Date.UTC(newer.year, newer.month - 1, newer.day)
    - Date.UTC(older.year, older.month - 1, older.day)) / 86400000);
  return Math.max(1, Math.round(days / 7));
}

// The third line of the ink's margin column: 5 MO, then 1 Y 2 once a year is in it. Nine characters max.
export function distanceStamp(matchDay, triggerDay) {
  const months = monthsApart(matchDay, triggerDay);
  if (!months) return t('journal.date.weeks', { weeks: weeksApart(matchDay, triggerDay) });
  if (months < 12) return t('journal.date.months', { months });
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (!rest) return t('journal.date.years', { years });
  return t('journal.date.yearsMonths', { years, months: rest });
}

// The connector between two chips in the trail; months however far the walk reaches.
export function distanceTrail(matchDay, triggerDay) {
  const months = monthsApart(matchDay, triggerDay);
  if (!months) return t('journal.date.weeks', { weeks: weeksApart(matchDay, triggerDay) });
  return t('journal.date.months', { months });
}

