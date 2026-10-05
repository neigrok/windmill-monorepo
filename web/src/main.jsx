import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './shell/App.jsx';
import { ErrorBoundary } from './design-system/feedback/ErrorBoundary.jsx';
import { reportError } from './telemetry/beacon.js';
// beforeinstallprompt fires once per page load, before the chip's route mounts, so arm it at boot.
import './shell/pwa/installPrompt.js';
import { PRODUCTS } from './shell/products.js';
import { captureError } from './telemetry/sentry.js';
import './styles/fonts.js';
import './styles/global.css';

// Resource-load errors carry no event.error; skip them.
window.addEventListener('error', (event) => { if (event.error) reportError(event.error, 'window'); });
window.addEventListener('unhandledrejection', (event) => reportError(event.reason, 'promise'));

if ('serviceWorker' in navigator) {
  performance.setResourceTimingBufferSize(4000);
  const offlineShell = async () => {
    try {
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
      });
      await Promise.all([import('./shell/chrome/Shell.jsx'), ...PRODUCTS.filter((p) => ['gym', 'journal'].includes(p.id)).map((p) => p.preloadApp())]);
      // Development's transformed module URLs have no build manifest.
      navigator.serviceWorker.controller?.postMessage({ type: 'warm', urls: performance.getEntriesByType('resource').map((entry) => entry.name) });
    } catch { captureError('offline', 'offline-shell', '', '/app'); }
  };
  if (document.readyState === 'complete') offlineShell();
  else window.addEventListener('load', offlineShell, { once: true });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
