// The install offer, stashed where it can't be missed. Chrome fires beforeinstallprompt once
// per page load, right after the manifest makes the page installable — which is before React
// has mounted the lazy shell route the chip lives in. So the capture is armed at module scope
// from main.jsx at boot and the chip only ever reads it: an event missed here is missed for the
// whole session, because the browser never fires it again.

let captured = null;
const watchers = new Set();

function announce() {
  for (const watcher of watchers) watcher();
}

export function installPrompt() {
  return captured;
}

export function watchInstallPrompt(watcher) {
  watchers.add(watcher);
  return () => { watchers.delete(watcher); };
}

// Cleared the moment the offer is taken or refused — the chip goes down synchronously, so a
// second tap can never reach the same event twice (the browser rejects a replayed prompt()).
export function forgetInstallPrompt() {
  captured = null;
  announce();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();  // the browser's own banner stays down; the quiet chip is the offer
    captured = event;
    announce();
  });
  window.addEventListener('appinstalled', forgetInstallPrompt);
}
