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

// The zero stamp — what an unparseable one reads as, and what an unstamped page carries. A page
// holding it loses every race, which is the safe direction to fail in.
export const ZERO_STAMP = '';

function parseStamp(text) {
  const parts = String(text ?? '').split(':');
  if (parts.length < 3) return { ms: 0, counter: 0, actor: '' };
  const ms = Number(parts[0]);
  const counter = Number(parts[1]);
  if (!Number.isFinite(ms) || !Number.isFinite(counter)) return { ms: 0, counter: 0, actor: '' };
  return { ms, counter, actor: parts.slice(2).join(':') };
}

// Exactly the order the server resolves a page by (backend platform/domain/Ids.h: Hlc's default
// spaceship over physicalMs, counter, actor) and exactly iOS's Hlc.<. The winner of a two-device
// race is therefore a fact all three sides compute identically, never a negotiation.
export function compareStamps(left, right) {
  const a = parseStamp(left);
  const b = parseStamp(right);
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
  return 0;
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

// How long until this device's calendar turns over — what a canvas left open overnight waits for.
// Local midnight, never UTC's, by the same rule localDay follows: the writer's day is the device's.
// Floored at a second so a timer that fires a hair early cannot spin.
export function msUntilNextDay(now = new Date()) {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(midnight.getTime() - now.getTime(), 1000);
}

// The tab was looked at again — the only signal that catches a midnight a timer slept through.
function browserWake(settle) {
  window.addEventListener('focus', settle);
  document.addEventListener('visibilitychange', settle);
  return () => {
    window.removeEventListener('focus', settle);
    document.removeEventListener('visibilitychange', settle);
  };
}

// THE CANVAS'S CLOCK. Says the local day, now and every time it changes, until the returned stop is
// called. A journal is written at night and the tab is still open in the morning, so a day read once
// at mount stops being today while the writer is still typing into it.
//
// A TIMER IS NOT A CLOCK, and this is why there are two halves. The timer is what turns a canvas
// over for somebody watching it happen at midnight; the wake is what catches every way a timer
// cannot be trusted — a laptop that slept through midnight, a background tab whose timers were
// throttled, a clock the writer moved by hand. Both say the same thing (the day, re-read from the
// device), so hearing it twice is harmless and hearing it once is enough.
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
