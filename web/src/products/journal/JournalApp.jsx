// The journal surface — one continuous canvas with on-device search a keystroke away.

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
import { openPosition, documentEntry } from './openPosition.js';
import './journal.css';

export function JournalApp({ hash }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [flyTo, setFlyTo] = useState(null);
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [settledDay, setSettledDay] = useState(null);
  const { resolved: theme } = useAppearance();
  const openSignInDoor = useSignInDoor();
  const lendDoorSkin = useSignInDoorHost();
  const { account: confirmed } = useAuth();
  // The device tier is scoped by account (pageCache.js), and it must be the confirmed account: the
  // shell's remembered hint may not open anybody's pages.
  const account = confirmed?.id ?? null;
  // The clock is the one the canvas turns over on, so a tab left open across midnight cannot leave the
  // echoes reading yesterday.
  const today = useToday();
  const echoes = useEchoes({ today, account, onFly: (target) => setFlyTo({ ...target, at: Date.now() }) });
  const nudge = useNudge(account);
  // The canvas lends the rail one write into today and keeps the store to itself.
  const writeRef = useRef(null);
  const holdWriter = useCallback((write) => { writeRef.current = write; }, []);

  // The hop mark decides the OPENING position only: the entry is a fact about the document, so this
  // answers the same for every render and every remount, and a hop away from it deep-links as usual.
  const focusDate = openPosition(hash, documentEntry());
  const openPage = echoes.openDay ? echoes.pageOf(echoes.openDay) : null;
  const sheetPage = echoes.sheetDay ? echoes.pageOf(echoes.sheetDay) : null;
  // The margin follows the scroll until a tab is opened, and then it holds that page. The follow is
  // committed only once the scroll has rested, so a fast pass does not strobe the panel.
  const marginPage = openPage || (settledDay ? echoes.pageOf(settledDay) : null);

  useEffect(() => {
    const day = echoes.followedDay;
    const settle = setTimeout(() => setSettledDay(day), 160);
    return () => clearTimeout(settle);
  }, [echoes.followedDay]);

  // ⌘K / Ctrl-K opens search.
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
      className={'journal-root' + (echoes.hasGutter ? ' has-gutter' : '') + (sheetPage ? ' is-sheeted' : '')}
      ref={lendDoorSkin}
      data-theme={theme}
    >
      <Canvas
        focusDate={focusDate}
        flyTo={flyTo}
        echoes={echoes}
        holdWriter={holdWriter}
      />
      <EchoMargin echoes={echoes} page={marginPage} />
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
      {/* Told which account they read, which is also which device scope they may open. */}
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
