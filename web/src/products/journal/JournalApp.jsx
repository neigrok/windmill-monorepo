// The journal surface — night by design (not the app's global theme), a single continuous canvas,
// and the superapp's switcher to step between rooms. Everything above the switcher is the canvas;
// the switcher is the only chrome, so nothing stands between the writer and the cursor.

import React from 'react';
import { ProductSwitcher } from '../../shell/ProductSwitcher.jsx';
import { Canvas } from './Canvas.jsx';
import './journal.css';

// A position is a URL (canon §11): #/journal is today, #/journal/2026-07-20 flies the canvas to
// that day, neighbours intact. The date is the only thing the canvas needs from the hash.
function focusDateOf(hash) {
  const match = /^#\/journal\/(\d{4}-\d{2}-\d{2})/.exec(hash || '');
  return match ? match[1] : null;
}

export function JournalApp({ hash }) {
  return (
    <div className="journal-root" data-theme="dark">
      <Canvas focusDate={focusDateOf(hash)} />
      <div className="journal-lamp" aria-hidden="true" />
      <div className="journal-switch">
        <ProductSwitcher current="journal" />
      </div>
    </div>
  );
}

export default JournalApp;
