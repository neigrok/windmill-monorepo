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
