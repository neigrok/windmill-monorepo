// The journal surface — night by design (not the app's global theme), a single continuous canvas,
// on-device search a keystroke away, and the superapp's switcher to step between rooms. Everything
// above the switcher is the canvas; nothing stands between the writer and the cursor.

import React, { useEffect, useState } from 'react';
import { Search, Bell, CalendarRange } from 'lucide-react';
import { ProductSwitcher } from '../../shell/ProductSwitcher.jsx';
import { Canvas } from './Canvas.jsx';
import { SearchOverlay } from './search/SearchOverlay.jsx';
import { EchoCard } from './EchoCard.jsx';
import { NudgePanel } from './NudgePanel.jsx';
import { ZoomView } from './zoom/ZoomView.jsx';
import { useEchoes } from './useEchoes.js';
import { useNudge } from './useNudge.js';
import './journal.css';

// A position is a URL (canon §11): #/journal is today, #/journal/2026-07-20 flies the canvas to
// that day, neighbours intact. The date is the only thing the canvas needs from the hash.
function focusDateOf(hash) {
  const match = /^#\/journal\/(\d{4}-\d{2}-\d{2})/.exec(hash || '');
  return match ? match[1] : null;
}

export function JournalApp({ hash }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [flyTo, setFlyTo] = useState(null);
  const [openEcho, setOpenEcho] = useState(null);
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const { byTriggerDay, dismiss } = useEchoes();
  const nudge = useNudge();

  // ⌘K / Ctrl-K opens search — the one shortcut, never in the writer's way.
  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="journal-root" data-theme="dark">
      <Canvas
        focusDate={focusDateOf(hash)}
        flyTo={flyTo}
        echoDays={byTriggerDay}
        onOpenEcho={(triggerDay) => setOpenEcho(byTriggerDay.get(triggerDay) || null)}
      />
      <div className="journal-lamp" aria-hidden="true" />
      <div className="journal-tools">
        <button
          type="button"
          className="journal-tool"
          onClick={() => setZoomOpen(true)}
          aria-label="Zoom out to your months"
          title="Zoom out"
        >
          <CalendarRange size={18} strokeWidth={1.9} aria-hidden="true" />
        </button>
        {nudge.armed && (
          <button
            type="button"
            className="journal-tool"
            onClick={() => setNudgeOpen(true)}
            aria-label="Nudges"
            title="Nudges"
          >
            <Bell size={18} strokeWidth={1.9} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="journal-tool journal-search-open"
          onClick={() => setSearchOpen(true)}
          aria-label="Search a feeling"
          title="Search a feeling (⌘K)"
        >
          <Search size={18} strokeWidth={1.9} aria-hidden="true" />
        </button>
      </div>
      <SearchOverlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={(hit) => { setFlyTo({ ...hit, at: Date.now() }); setSearchOpen(false); }}
      />
      {openEcho && (
        <EchoCard
          echo={openEcho}
          onClose={() => setOpenEcho(null)}
          onRead={(echo) => {
            setFlyTo({ day: echo.matchDay, lo: echo.matchSpan[0], hi: echo.matchSpan[1], at: Date.now() });
            setOpenEcho(null);
          }}
          onDismiss={(triggerDay) => { dismiss(triggerDay); setOpenEcho(null); }}
        />
      )}
      {nudgeOpen && <NudgePanel nudge={nudge} onClose={() => setNudgeOpen(false)} />}
      {zoomOpen && (
        <ZoomView
          onClose={() => setZoomOpen(false)}
          onPick={(date) => { setFlyTo({ day: date, at: Date.now() }); setZoomOpen(false); }}
        />
      )}
      <div className="journal-switch">
        <ProductSwitcher current="journal" />
      </div>
    </div>
  );
}

export default JournalApp;
