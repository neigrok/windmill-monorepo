// beforeinstallprompt fires once per page load, so the capture is armed at module scope from
// main.jsx at boot; an event missed here is missed for the whole session.

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

// Cleared synchronously when the offer is taken or refused, so a second tap finds nothing.
export function forgetInstallPrompt() {
  captured = null;
  announce();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();  // keep the browser's own banner down
    captured = event;
    announce();
  });
  window.addEventListener('appinstalled', forgetInstallPrompt);
}
