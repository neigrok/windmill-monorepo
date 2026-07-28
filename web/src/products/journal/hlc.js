// The device's hybrid logical clock — the sole convergence key for a page, ordered exactly like the
// server's Hlc. A stamp is "physicalMs:counter:actor": counter breaks ties inside one millisecond,
// actor is a stable per-device id so two devices never collide on (ms, counter).

const ACTOR_KEY = 'wm.journal.device';

function actor() {
  let id = null;
  try {
    id = localStorage.getItem(ACTOR_KEY);
    if (!id) {
      id = 'd-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(ACTOR_KEY, id);
    }
  } catch {
    id = 'd-ephemeral';
  }
  return id;
}

let lastMs = 0;
let counter = 0;

export function mintStamp() {
  const ms = Math.max(Date.now(), lastMs);
  counter = ms === lastMs ? counter + 1 : 0;
  lastMs = ms;
  return `${ms}:${counter}:${actor()}`;
}

// The writer's local day, "YYYY-MM-DD" — the page key. The device owns the calendar, never UTC.
export function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// N days before a given ISO day, still local — for loading a window back from today.
export function daysBefore(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d - n);
  return localDay(date);
}
