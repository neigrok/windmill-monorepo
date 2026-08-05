// Every date and every distance an echo renders, in the exact shapes the design names — and nothing
// else. The server sends ISO days only; the reading of them is ours.
//
// Since the edge-tab revision the surface renders no prose distance at all: a distance is a mono
// stamp in the ink's margin column ("5 MO", "1 Y 2") or a connector in the trail ("18 MO"). That is
// why there is no "ago" and no "earlier" here any more — a bare span holds wherever the reader is
// standing, and every span is still measured FROM the trigger page's day, never from today.

const SHORT_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Prose spells its numbers; mono counts them. Past twenty a reach is measured in years anyway.
const SPELLED = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

function parts(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// "14 MAR" / "2026" — the two lines the ink's margin column hangs a passage off.
export function stampStacked(iso) {
  const { year, month, day } = parts(iso);
  return { head: `${pad(day)} ${SHORT_MONTHS[month - 1]}`, year: String(year) };
}

// 02 NOV 25 — the run of other dates, where the column is narrow and the century is not in doubt.
export function stampCompact(iso) {
  const { year, month, day } = parts(iso);
  return `${pad(day)} ${SHORT_MONTHS[month - 1]} ${String(year).slice(-2)}`;
}

// 14 MAR 2026 — a trail chip, the one place a date is a position you can stand on again.
export function stampPlain(iso) {
  const { year, month, day } = parts(iso);
  return `${pad(day)} ${SHORT_MONTHS[month - 1]} ${year}`;
}

// 14 March — the free path names the page by day and month, because the year is on screen already.
export function proseDayMonth(iso) {
  const { month, day } = parts(iso);
  return `${day} ${MONTHS[month - 1]}`;
}

// Months between two days, older first, to the NEAREST month — 14 March → 4 August is five months,
// as the design reads it, not four-and-most-of-another. Rounding is on the calendar, not on an
// average month: the leftover is weighed against the actual month it falls in.
//
// The rounding runs from zero, and that matters: a 30-day reach is one month, not none. Returning
// early on a whole count of zero sent every sub-calendar-month gap to the paywall sheet as "read
// across zero months to find it" — a sentence that undersells the reach to the one reader being
// asked to pay for it. Only a backwards pair short-circuits, and only because it cannot happen:
// the CHECK on journal_echo makes reaching forward unrepresentable.
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

// The third line of the ink's margin column: 5 MO, then 1 Y 2 once a year is in it. Nine characters
// is the whole budget, so the year is a letter and the leftover months lose their unit.
export function distanceStamp(matchDay, triggerDay) {
  const months = monthsApart(matchDay, triggerDay);
  if (!months) return `${weeksApart(matchDay, triggerDay)} WK`;
  if (months < 12) return `${months} MO`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years} Y ${rest}` : `${years} Y`;
}

// The connector between two chips in the trail. It stays in months however far the walk reaches —
// "18 MO" is the distance of one hop, and a hop is easier to feel in one unit than in two.
export function distanceTrail(matchDay, triggerDay) {
  const months = monthsApart(matchDay, triggerDay);
  if (!months) return `${weeksApart(matchDay, triggerDay)} WK`;
  return `${months} MO`;
}

// "two and a half years" — what One read across to find the nearest match. Derived from the oldest
// match and the trigger day, never asserted: the sentence is only ever as wide as the dates on screen.
//
// Under half a month it counts weeks, exactly as the two stamps above do. A young corpus whose
// oldest match is nine days back is a small reach and the sheet should say so — what it must never
// say is "zero months", which is the one reading of this that is not true of any pair of days.
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
