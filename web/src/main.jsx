import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { ErrorBoundary } from './components/feedback/ErrorBoundary.jsx';
import { reportError } from './telemetry/beacon.js';
import './styles/fonts.js';
import './styles/global.css';

// The React boundary catches render/lifecycle throws; these catch what escapes it — a throw
// from an event handler / async callback, and a rejected promise nobody awaited. Both beacon
// as client_error so a prod exception is queryable instead of invisible. Resource-load errors
// (a missing img/script — event.error is absent) are skipped as noise.
window.addEventListener('error', (event) => { if (event.error) reportError(event.error, 'window'); });
window.addEventListener('unhandledrejection', (event) => reportError(event.reason, 'promise'));

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
