import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './shell/App.jsx';
import { ErrorBoundary } from './design-system/feedback/ErrorBoundary.jsx';
import { reportError } from './telemetry/beacon.js';
// beforeinstallprompt fires once per page load, before React mounts the lazy shell route the
// install chip lives in — so the stash is armed here at boot, not by the chip.
import './shell/pwa/installPrompt.js';
import './styles/fonts.js';
import './styles/global.css';

// The React boundary catches render/lifecycle throws; these catch what escapes it — a throw
// from an event handler / async callback, and a rejected promise nobody awaited. Both beacon
// as client_error so a prod exception is queryable instead of invisible. Resource-load errors
// (a missing img/script — event.error is absent) are skipped as noise.
window.addEventListener('error', (event) => { if (event.error) reportError(event.error, 'window'); });
window.addEventListener('unhandledrejection', (event) => reportError(event.reason, 'promise'));

// The app-shell service worker — production only, after load so it never competes with the
// boot, and a failed registration is a no-op: the app must work exactly as before without it.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
