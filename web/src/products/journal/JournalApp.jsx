// The journal surface — a single continuous canvas with on-device search a keystroke away.
// Everything here is the canvas; nothing stands between the writer and the cursor. The account seat
// is not this room's to draw: the /app shell carries one seat above every room (shell/chrome/
// Shell.jsx), and journal drew a second one at the same coordinates until 2026-08-07.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Bell, CalendarRange } from 'lucide-react';
import { ProductSwitcher } from '../../shell/ProductSwitcher.jsx';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { useSignInDoor, useSignInDoorHost } from '../../shell/auth/SignInDoor.jsx';
import { useAppearance } from '../../shell/useAppearance.js';
import { Canvas } from './Canvas.jsx';
import { TalkButton } from './TalkButton.jsx';
import { SearchOverlay } from './search/SearchOverlay.jsx';
import { NudgePanel } from './NudgePanel.jsx';
import { ZoomView } from './zoom/ZoomView.jsx';
import { EchoMargin } from './echoes/EchoMargin.jsx';
import { InkFooter } from './echoes/Ink.jsx';
import { EchoTrail, BackToTonight } from './echoes/EchoTrail.jsx';
import { OneSheet } from './echoes/OneSheet.jsx';
import { useEchoes } from './echoes/useEchoes.js';
import { useToday } from './usePages.js';
import { useNudge } from './useNudge.js';
import './journal.css';

// A position is a URL (canon §11): #/journal is today, #/journal/2026-07-20 flies the canvas to
// that day, neighbours intact. The date is the only thing the canvas needs from the hash.
function focusDateOf(hash) {
  const match = /^#\/journal\/(\d{4}-\d{2}-\d{2})/.exec(hash || '');
  return match ? match[1] : null;
}

// Light or dark is NOT journal's choice: the superapp's one Appearance setting decides for the
// whole app (shell/appearance.js), and journal maps it onto its own two skins — dark is dusk with
// one candle, light is paper in north light. Journal carried its own toggle in the tool rail until
// 2026-08-05; it meant the setting in Account settings could not reach this room, and the app had
// two controls for one thing. Night is still what this surface was designed as — the app's dark is
// simply what selects it now.

export function JournalApp({ hash }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [flyTo, setFlyTo] = useState(null);
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const { resolved: theme } = useAppearance();
  const openSignInDoor = useSignInDoor();
  const lendDoorSkin = useSignInDoorHost();
  const { account: confirmed } = useAuth();
  // The device tier is scoped by account (pageCache.js), and search, the echoes and the year zoom
  // read it as much as the canvas does — so they are told WHICH account's journal they are reading,
  // never merely that somebody is signed in. It is the CONFIRMED account (shell/auth): a remembered
  // hint paints a face on the first frame and may not open anybody's pages.
  const account = confirmed?.id ?? null;
  // Walking an echo is a position change, so the hook hands the canvas the same flight a search hit
  // gets: load the day if it is older than the window, centre it, and light the passage for a beat.
  // The one clock the canvas turns over on (usePages.js), so a tab left open across midnight does
  // not leave the echoes reading yesterday while the canvas has already opened tonight's page.
  const today = useToday();
  const echoes = useEchoes({ today, account, onFly: (target) => setFlyTo({ ...target, at: Date.now() }) });
  const nudge = useNudge(account);
  // Talk is a tool and sits in the rail with the others, but what it produces is today's writing —
  // so the canvas lends the rail the one write into today and keeps the store to itself.
  const writeRef = useRef(null);
  const holdWriter = useCallback((write) => { writeRef.current = write; }, []);

  const focusDate = focusDateOf(hash);
  const openPage = echoes.openDay ? echoes.pageOf(echoes.openDay) : null;
  const sheetPage = echoes.sheetDay ? echoes.pageOf(echoes.sheetDay) : null;
  // The margin follows the scroll until a tab is opened, and then it holds that page — so the
  // sentence at its foot ("this panel follows the scroll") stays true of the state it describes.
  const marginPage = openPage || (echoes.followedDay ? echoes.pageOf(echoes.followedDay) : null);

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
    <div
      className={'journal-root' + (marginPage ? ' has-margin' : '') + (sheetPage ? ' is-sheeted' : '')}
      ref={lendDoorSkin}
      data-theme={theme}
    >
      <Canvas
        focusDate={focusDate}
        flyTo={flyTo}
        echoes={echoes}
        holdWriter={holdWriter}
      />
      {marginPage && <EchoMargin echoes={echoes} page={marginPage} />}
      {openPage && <InkFooter echoes={echoes} page={openPage} />}
      <EchoTrail echoes={echoes} current={focusDate || echoes.today} />
      <BackToTonight echoes={echoes} />
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
        <TalkButton
          onTranscript={(text) => writeRef.current?.(text)}
          onNeedSignIn={openSignInDoor}
        />
      </div>
      {/* Search and the zoom read the whole journal rather than a window, and the whole journal is
          the account's pages plus this device's — so both need to know WHICH account they are
          reading, which is also which device scope they may open. Asked once, here, where the
          confirmed account already is. */}
      <SearchOverlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={(hit) => { setFlyTo({ ...hit, at: Date.now() }); setSearchOpen(false); }}
        account={account}
      />
      {sheetPage && (
        <OneSheet
          page={sheetPage}
          onClose={echoes.closeSheet}
          onNotNow={() => echoes.retireOffer(sheetPage.day)}
          onNeedSignIn={openSignInDoor}
        />
      )}
      {nudgeOpen && <NudgePanel nudge={nudge} onClose={() => setNudgeOpen(false)} />}
      {zoomOpen && (
        <ZoomView
          onClose={() => setZoomOpen(false)}
          onPick={(date) => { setFlyTo({ day: date, at: Date.now() }); setZoomOpen(false); }}
          account={account}
        />
      )}
      <div className="wm-post wm-post-switch">
        <ProductSwitcher current="journal" />
      </div>
    </div>
  );
}

export default JournalApp;
