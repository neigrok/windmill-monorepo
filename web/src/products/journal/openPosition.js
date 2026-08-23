// Where the canvas opens, and the one rule that decides it: a hop marks itself; a marked entry opens
// on tonight. A dated URL is a real deep link — someone who is sent #/journal/2026-07-14 lands on
// that day — but an in-canvas echo hop writes a day into the address bar too, and that day was never
// a destination the writer chose. So a hop stamps its history entry, and the stamped entry a document
// LOADED with (a reload, a restored tab, a bookmark taken mid-walk) means tonight, not the day in the
// bar. Anywhere else the stamp decides nothing: a hop still flies the canvas to its day.

export const HOP_MARK = 'journalHop';

// Same shape the canvas has always deep-linked on: #/journal is tonight, #/journal/<iso> is that day.
export function dayOfHash(hash) {
  const match = /^#\/journal\/(\d{4}-\d{2}-\d{2})/.exec(hash || '');
  return match ? match[1] : null;
}

export function markedAsHop(historyState) {
  return Boolean(historyState && historyState[HOP_MARK] === true);
}

// The door this document came in through, read once at import and never again. It is a fact about the
// page load, so it must not be spendable: a latch handed to "whoever asks first" is lost to the next
// remount — StrictMode's double mount, a Suspense retry, an auth remount — and the canvas silently
// falls back to deep-linking the day a hop left in the bar. Every reader gets this same answer.
const ENTRY = Object.freeze(
  typeof window === 'undefined'
    ? { hash: '', marked: false }
    : { hash: window.location.hash || '', marked: markedAsHop(window.history.state) },
);

export function documentEntry() {
  return ENTRY;
}

// `focusDate` for the canvas: a day the writer deliberately asked for by URL, or null for tonight.
// Pure over plain values — hash in hand, entry in hand — so the rule is checkable without a browser.
export function openPosition(hash, entry) {
  const day = dayOfHash(hash);
  if (!day) return null;
  if (entry?.marked === true && (hash || '') === (entry.hash || '')) return null;
  return day;
}

// A hop is a real history entry — the browser Back button is how the trail is walked back — so this
// is pushState and never replaceState. pushState fires no `hashchange`, and the shell routes off
// `hashchange`/`popstate` (shell/App.jsx), so the hop announces itself with the popstate the shell
// is already listening for.
export function hopToHash(hash) {
  window.history.pushState({ [HOP_MARK]: true }, '', hash);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
