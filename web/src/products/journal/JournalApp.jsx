// The journal surface — night by default (a warm day is a keystroke away in the tool rail), a single
// continuous canvas, on-device search a keystroke away, and the superapp's switcher to step between
// rooms. A quiet account seat sits opposite the switcher — the one unprompted mention of sign-in —
// so a writer can claim their days across devices without ever leaving the page. Everything above the
// chrome is the canvas; nothing stands between the writer and the cursor.

import React, { useEffect, useState } from 'react';
import { Search, Bell, CalendarRange, Sun, Moon } from 'lucide-react';
import { ProductSwitcher } from '../../shell/ProductSwitcher.jsx';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { AccountSeat } from '../../shell/auth/AccountSeat.jsx';
import { useSignInDoor, useSignInDoorHost } from '../../shell/auth/SignInDoor.jsx';
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

// The surface theme is the device's own choice, kept beside the journal's other per-device state
// (see hlc.js) — it is deliberately NOT the app's global theme, which stays light everywhere else.
// Night is the default the journal was designed as; a returning writer paints in their last choice.
const THEME_KEY = 'windmill:journal-theme';

function readTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* storage unavailable — night is the honest default */ }
  return 'dark';
}

export function JournalApp({ hash }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [flyTo, setFlyTo] = useState(null);
  const [openEcho, setOpenEcho] = useState(null);
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [theme, setTheme] = useState(readTheme);
  const openSignInDoor = useSignInDoor();
  const lendDoorSkin = useSignInDoorHost();
  const { user, status, signOut } = useAuth();
  const { byTriggerDay, dismiss } = useEchoes();
  const nudge = useNudge();

  const toggleTheme = () => setTheme((current) => {
    const next = current === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable — the choice is device-local anyway */ }
    return next;
  });

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
    <div className="journal-root" ref={lendDoorSkin} data-theme={theme}>
      <Canvas
        focusDate={focusDateOf(hash)}
        flyTo={flyTo}
        echoDays={byTriggerDay}
        onOpenEcho={(triggerDay) => setOpenEcho(byTriggerDay.get(triggerDay) || null)}
        onNeedSignIn={openSignInDoor}
      />
      <div className="journal-lamp" aria-hidden="true" />
      <div className="journal-seat">
        <AccountSeat
          user={user}
          status={status}
          onSignIn={openSignInDoor}
          onSignOut={signOut}
          onSettings={() => { window.location.hash = '#/settings'; }}
          onConnect={() => { window.location.hash = '#/connect'; }}
        />
      </div>
      <div className="journal-tools">
        <button
          type="button"
          className="journal-tool"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to day' : 'Switch to night'}
          title={theme === 'dark' ? 'Day' : 'Night'}
        >
          {theme === 'dark'
            ? <Sun size={18} strokeWidth={1.9} aria-hidden="true" />
            : <Moon size={18} strokeWidth={1.9} aria-hidden="true" />}
        </button>
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
