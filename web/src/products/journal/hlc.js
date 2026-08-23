// The sole convergence key for a page, ordered exactly like the server's Hlc. A stamp is
// "physicalMs:counter:actor": counter breaks ties inside one millisecond, actor is a stable per-device id.

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

// What an unparseable stamp reads as, and what an unstamped page carries; it loses every race.
export const ZERO_STAMP = '';

function parseStamp(text) {
  const parts = String(text ?? '').split(':');
  if (parts.length < 3) return { ms: 0, counter: 0, actor: '' };
  const ms = Number(parts[0]);
  const counter = Number(parts[1]);
  if (!Number.isFinite(ms) || !Number.isFinite(counter)) return { ms: 0, counter: 0, actor: '' };
  return { ms, counter, actor: parts.slice(2).join(':') };
}

// Exactly the order the server and iOS resolve a page by: physicalMs, then counter, then actor.
export function compareStamps(left, right) {
  const a = parseStamp(left);
  const b = parseStamp(right);
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
  return 0;
}

// The writer's local day, "YYYY-MM-DD" — the page key. Local, never UTC.
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

// Local midnight, never UTC's, floored at a second so a timer that fires a hair early cannot spin.
export function msUntilNextDay(now = new Date()) {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(midnight.getTime() - now.getTime(), 1000);
}

// Catches a midnight a timer slept through.
function browserWake(settle) {
  window.addEventListener('focus', settle);
  document.addEventListener('visibilitychange', settle);
  return () => {
    window.removeEventListener('focus', settle);
    document.removeEventListener('visibilitychange', settle);
  };
}

// The local day, now and every time it changes, until the returned stop is called. Two halves: the timer
// turns the canvas over at midnight, the wake catches a slept-through one. Hearing it twice is harmless.
export function watchLocalDay(onDay, {
  setTimer = (run, delay) => setTimeout(run, delay),
  clearTimer = (timer) => clearTimeout(timer),
  wake = browserWake,
} = {}) {
  let timer = null;
  const settle = () => {
    onDay(localDay());
    clearTimer(timer);
    timer = setTimer(settle, msUntilNextDay());
  };
  timer = setTimer(settle, msUntilNextDay());
  const stopWake = wake(settle);
  return () => {
    clearTimer(timer);
    stopWake();
  };
}
