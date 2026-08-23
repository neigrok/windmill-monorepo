import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './shell/App.jsx';
import { ErrorBoundary } from './design-system/feedback/ErrorBoundary.jsx';
import { reportError } from './telemetry/beacon.js';
// beforeinstallprompt fires once per page load, before the chip's route mounts, so arm it at boot.
import './shell/pwa/installPrompt.js';
import './styles/fonts.js';
import './styles/global.css';

// Resource-load errors carry no event.error; skip them.
window.addEventListener('error', (event) => { if (event.error) reportError(event.error, 'window'); });
window.addEventListener('unhandledrejection', (event) => reportError(event.reason, 'promise'));

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
