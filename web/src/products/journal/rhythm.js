// The adaptive part of a nudge, computed entirely on the device. From the local hours a writer
// actually wrote (each page's last-write time, read in the browser's own timezone), it finds the hour
// they tend to write and materializes the next instant to knock — at least a lead-time out, so a nudge
// is never "right now". Only that single instant and its day cross to the server (useNudge PATCHes
// them); the histogram of hours never leaves. No page history yet ⇒ a gentle evening default.

const DEFAULT_HOUR = 20;
const MIN_LEAD_MS = 20 * 60 * 60 * 1000;   // at least ~a day out — tomorrow's rhythm, not this moment

// The hour a writer writes most (ties break to the earlier hour). Pure over an array of 0–23 hours so
// it's deterministic to test; the timezone-dependent extraction lives in nextNudge.
export function modalHour(hours, fallback = DEFAULT_HOUR) {
  if (hours.length === 0) return fallback;
  const counts = new Map();
  for (const hour of hours) counts.set(hour, (counts.get(hour) || 0) + 1);
  let best = fallback;
  let bestCount = -1;
  for (const [hour, count] of counts) {
    if (count > bestCount || (count === bestCount && hour < best)) { best = hour; bestCount = count; }
  }
  return best;
}

function localDayOf(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Materialize the next knock: the usual hour, on the soonest day that is at least a lead-time away.
// `now` is passed in (a number of ms) so this stays a pure, testable function.
export function nextNudge(pages, now, minLeadMs = MIN_LEAD_MS) {
  const hours = pages
    .filter((page) => page.updatedAt)
    .map((page) => new Date(page.updatedAt).getHours());
  const hour = modalHour(hours);
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  while (at.getTime() - now < minLeadMs) at.setDate(at.getDate() + 1);
  return { nextDueAt: at.getTime(), slotDay: localDayOf(at), hour };
}
