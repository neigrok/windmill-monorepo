// Every date and every distance an echo renders, in the exact shapes the design names — and nothing
// else. The server sends ISO days only; the reading of them is ours.
//
// Distance is measured FROM the trigger page's day, never from today. An echo on a page you walked
// back to is "eight months earlier" than THAT page; saying "ago" there would be a claim about where
// the reader is standing, and the reader is standing in September 2024.

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const SHORT_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Prose spells its numbers; mono counts them. Past twenty an echo is measured in years anyway.
const SPELLED = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

function parts(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day, weekday: WEEKDAYS[new Date(year, month - 1, day).getDay()] };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function spell(n) {
  return SPELLED[n] ?? String(n);
}

// SAT 14 MARCH 2026 — the opened card's header, the one place the month is written out in mono.
export function stampLong(iso) {
  const { year, month, day, weekday } = parts(iso);
  return `${weekday} ${pad(day)} ${MONTHS[month - 1].toUpperCase()} ${year}`;
}

// SAT 14 MAR 2026 — a match row's header in the panel.
export function stampShort(iso) {
  const { year, month, day, weekday } = parts(iso);
  return `${weekday} ${pad(day)} ${SHORT_MONTHS[month - 1]} ${year}`;
}

// 14 MAR 2026 — every secondary date row, and every date on the desktop margin panel.
export function stampPlain(iso) {
  const { year, month, day } = parts(iso);
  return `${pad(day)} ${SHORT_MONTHS[month - 1]} ${year}`;
}

// AUGUST 2026 — the header chip.
export function stampMonth(iso) {
  const { year, month } = parts(iso);
  return `${MONTHS[month - 1].toUpperCase()} ${year}`;
}

// 1 January 2024 — a date inside a sentence, no leading zero.
export function proseDate(iso) {
  const { year, month, day } = parts(iso);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

// 14 March — the free path names the page by day and month, because the year is on screen already.
export function proseDayMonth(iso) {
  const { month, day } = parts(iso);
  return `${day} ${MONTHS[month - 1]}`;
}

// Months between two days, older first, to the NEAREST month — 14 March → 4 August is five months,
// as the design reads it, not four-and-most-of-another. Rounding is on the calendar, not on an
// average month: the leftover is weighed against the actual month it falls in.
export function monthsApart(olderIso, newerIso) {
  const older = parts(olderIso);
  const newer = parts(newerIso);
  const whole = (newer.year - older.year) * 12 + (newer.month - older.month) - (newer.day < older.day ? 1 : 0);
  if (whole <= 0) return Math.max(0, whole);
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

function plural(n, word) {
  return `${spell(n)} ${n === 1 ? word : `${word}s`}`;
}

// "five months" · "one year, two months" — the spoken span both prose distances are built from.
function spokenSpan(months) {
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (!years) return plural(months, 'month');
  if (!rest) return plural(years, 'year');
  return `${plural(years, 'year')}, ${plural(rest, 'month')}`;
}

// On tonight's page: "five months ago". Past a year the design drops the suffix — "one year, two
// months" — because at that range the word stops adding anything the date didn't already say.
export function distanceAgo(matchDay, triggerDay) {
  const months = monthsApart(matchDay, triggerDay);
  if (!months) return `${plural(weeksApart(matchDay, triggerDay), 'week')} ago`;
  if (months < 12) return `${spokenSpan(months)} ago`;
  return spokenSpan(months);
}

// On a page you walked back to. "Earlier" is not deictic: it holds wherever the reader is standing.
export function distanceEarlier(matchDay, triggerDay) {
  const months = monthsApart(matchDay, triggerDay);
  if (!months) return `${plural(weeksApart(matchDay, triggerDay), 'week')} earlier`;
  return `${spokenSpan(months)} earlier`;
}

// The desktop margin panel, where the column is 308px and every word costs a wrap: "five months",
// then "1 yr 2 mo" once a year is in it.
export function distanceCompact(matchDay, triggerDay) {
  const months = monthsApart(matchDay, triggerDay);
  if (!months) return `${weeksApart(matchDay, triggerDay)} wk`;
  if (months < 12) return plural(months, 'month');
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years} yr ${rest} mo` : `${years} yr`;
}

// The connector between two chips in the trail: 5 MO.
export function distanceTrail(matchDay, triggerDay) {
  const months = monthsApart(matchDay, triggerDay);
  if (!months) return `${weeksApart(matchDay, triggerDay)} WK`;
  return `${months} MO`;
}

// "two and a half years" — what One read across to find the nearest match. Derived from the oldest
// match and the trigger day, never asserted: the sentence is only ever as wide as the dates on screen.
export function reachInWords(oldestDay, triggerDay) {
  const months = monthsApart(oldestDay, triggerDay);
  if (months < 12) return plural(months, 'month');
  const halves = Math.round(months / 6) / 2;
  const whole = Math.floor(halves);
  if (halves === whole) return plural(whole, 'year');
  return `${spell(whole)} and a half years`;
}
