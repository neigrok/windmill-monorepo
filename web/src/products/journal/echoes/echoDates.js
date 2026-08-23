// The server sends ISO days only. A distance is a bare span, always measured from the trigger page's
// day, never from today.

const SHORT_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const SPELLED = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

function parts(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// "14 MAR" / "2026" — the two lines of the ink's margin column.
export function stampStacked(iso) {
  const { year, month, day } = parts(iso);
  return { head: `${pad(day)} ${SHORT_MONTHS[month - 1]}`, year: String(year) };
}

// 02 NOV 25 — the run of other dates, where the column is narrow.
export function stampCompact(iso) {
  const { year, month, day } = parts(iso);
  return `${pad(day)} ${SHORT_MONTHS[month - 1]} ${String(year).slice(-2)}`;
}

// 14 MAR 2026 — a trail chip.
export function stampPlain(iso) {
  const { year, month, day } = parts(iso);
  return `${pad(day)} ${SHORT_MONTHS[month - 1]} ${year}`;
}

// 14 March — the free path names the page by day and month.
export function proseDayMonth(iso) {
  const { month, day } = parts(iso);
  return `${day} ${MONTHS[month - 1]}`;
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
  if (!months) return `${weeksApart(matchDay, triggerDay)} WK`;
  if (months < 12) return `${months} MO`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years} Y ${rest}` : `${years} Y`;
}

// The connector between two chips in the trail; months however far the walk reaches.
export function distanceTrail(matchDay, triggerDay) {
  const months = monthsApart(matchDay, triggerDay);
  if (!months) return `${weeksApart(matchDay, triggerDay)} WK`;
  return `${months} MO`;
}

// "two and a half years", from the oldest match and the trigger day. Under half a month it counts weeks;
// it never says "zero months".
export function reachInWords(oldestDay, triggerDay) {
  const months = monthsApart(oldestDay, triggerDay);
  const spell = (n) => SPELLED[n] ?? String(n);
  if (!months) {
    const weeks = weeksApart(oldestDay, triggerDay);
    return `${spell(weeks)} ${weeks === 1 ? 'week' : 'weeks'}`;
  }
  if (months < 12) return `${spell(months)} ${months === 1 ? 'month' : 'months'}`;
  const halves = Math.round(months / 6) / 2;
  const whole = Math.floor(halves);
  if (halves === whole) return `${spell(whole)} ${whole === 1 ? 'year' : 'years'}`;
  return `${spell(whole)} and a half years`;
}
