// Gym — the training log's web surface, in the instrument skin. This file is the frame and none of
// the rooms: it resolves the account, holds the ONE live session, and hands each hash to the screen
// that answers it (Today · The log · Routines · Statistics, plus one session, one routine, one
// finish and the past-workout door).
//
// The live session IS workout mode — while it runs on Today, the tabs and the shell's own chrome are
// not drawn, and the screen is held awake. Nothing here decides anything: the rules live in log.js,
// routines.js, review.js, stats.js, backfill.js, share/ and logger/.

import React from 'react';
import { ProductSwitcher } from '../../shell/ProductSwitcher.jsx';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { AccountSeat } from '../../shell/auth/AccountSeat.jsx';
import { useSignInDoor, useSignInDoorHost } from '../../shell/auth/SignInDoor.jsx';
import { Backfill } from './Backfill.jsx';
import { FinishScreen } from './Finish.jsx';
import { LogList, SessionDetail } from './Log.jsx';
import { RoutineEditor, RoutinesList } from './Routines.jsx';
import { Stats } from './Stats.jsx';
import { Today } from './Today.jsx';
import {
  clockOf, finishIdOf, fmt, nameOfMovement, ROUTINES_HREF, routineIdOf, routineNameOf, screenOf,
  sessionIdOf, setCountLabel, sharedTokenOf, STATS_HREF,
} from './log.js';
import { Logger } from './logger/Logger.jsx';
import { SharedSession } from './share/SharedSession.jsx';
import { useLiveSession } from './logger/useLiveSession.js';
import './gym.css';

// The four rooms a lifter navigates between. Everything else — a session, a routine, the finish,
// the backfill form — is somewhere they went from one of them, and each carries its own way back.
const TAB_SCREENS = ['today', 'log', 'routines', 'stats'];

export function GymApp({ hash }) {
  const { user, status, signOut } = useAuth();
  const openSignInDoor = useSignInDoor();
  const lendDoorSkin = useSignInDoorHost();
  const sharedToken = sharedTokenOf(hash);

  // THE COACH'S PAGE, ANSWERED BEFORE THE ACCOUNT IS. The token in the URL is the whole credential,
  // so this branch reads no auth state, waits for none, and offers no door back into the app: a
  // person opening a link somebody sent them is a reader of one workout and not a lapsed lifter to
  // be recovered. Every hook above runs first, unconditionally — the early return is under them,
  // never between them.
  if (sharedToken) {
    return (
      <div className="gym-root" data-theme="dark">
        <SharedSession token={sharedToken} />
      </div>
    );
  }

  return (
    <div className="gym-root" ref={lendDoorSkin} data-theme="dark">
      {/* Three auth states, three answers — a first visit resolves through 'loading' with no stored
          hint, and an empty screen would read as a broken app. */}
      {status === 'loading' && <main className="gym-column"><p className="gym-quiet">Opening the log…</p></main>}
      {status === 'ghost' && (
        <>
          <Chrome user={user} status={status} onSignIn={openSignInDoor} onSignOut={signOut} />
          <main className="gym-column"><SignInPitch onSignIn={openSignInDoor} /></main>
        </>
      )}
      {status === 'signed-in' && (
        <TrainingRoom hash={hash} user={user} status={status} onSignIn={openSignInDoor} onSignOut={signOut} />
      )}
    </div>
  );
}

function Chrome({ user, status, onSignIn, onSignOut }) {
  return (
    <>
      <div className="wm-post wm-post-seat">
        <AccountSeat
          user={user}
          status={status}
          onSignIn={onSignIn}
          onSignOut={onSignOut}
          onSettings={() => { window.location.hash = '#/settings'; }}
          onConnect={() => { window.location.hash = '#/connect'; }}
        />
      </div>
      <div className="wm-post wm-post-switch">
        <ProductSwitcher current="gym" />
      </div>
    </>
  );
}

function SignInPitch({ onSignIn }) {
  return (
    <section className="gym-door">
      <h1 className="gym-title">Training log</h1>
      <p className="gym-door-line">Sign in to open your training log.</p>
      <button type="button" className="gym-door-button" onClick={onSignIn}>Sign in</button>
    </section>
  );
}

function TrainingRoom({ hash, user, status, onSignIn, onSignOut }) {
  // ONE instance, and every room reads the session, the catalog and the log off it. A second would
  // mean a second flush queue over one localStorage key and a second boot flush.
  const live = useLiveSession();
  const screen = screenOf(hash);
  const logging = live.phase === 'live' && screen === 'today';

  return (
    <>
      {!logging && <Chrome user={user} status={status} onSignIn={onSignIn} onSignOut={onSignOut} />}
      {logging && <Logger live={live} />}
      {!logging && (
        <main className="gym-column">
          {live.session && <LiveBand live={live} />}
          {screen === 'today' && <Today live={live} />}
          {screen === 'log' && <LogList live={live} />}
          {screen === 'routines' && <RoutinesList live={live} />}
          {screen === 'stats' && <Stats />}
          {/* KEYED BY THE DOCUMENT IT EDITS. The editor holds a DRAFT of one routine, and a draft
              may not outlive the routine it is of: the key is what makes React drop the instance
              when the hash moves to another one. The editor's own Duplicate button moves it — and
              without the key the copy's URL would be drawn over the original's unsaved edits, and
              Done would whole-document PUT them back onto the original. */}
          {screen === 'routine' && <RoutineEditor key={routineIdOf(hash)} id={routineIdOf(hash)} live={live} />}
          {screen === 'session' && <SessionDetail id={sessionIdOf(hash)} />}
          {screen === 'finish' && <FinishScreen id={finishIdOf(hash)} live={live} />}
          {screen === 'backfill' && <Backfill live={live} />}
        </main>
      )}
      {!logging && TAB_SCREENS.includes(screen) && <TabBar screen={screen} />}
      {live.refusals.length > 0 && (
        <p className="gym-refused">
          {`${live.refusals.map((each) => `${nameOfMovement(live.catalog, each.exerciseId)} ${fmt(each.weightKg)} × ${each.reps}`).join(', ')} never reached the log — ${live.refusals[0].reason}. Log ${live.refusals.length === 1 ? 'it' : 'them'} again to keep ${live.refusals.length === 1 ? 'it' : 'them'}.`}
          <button type="button" className="gym-refused-clear" onClick={live.clearRefusals}>Dismiss</button>
        </p>
      )}
      {live.toast && (
        <div className="gym-toast" role="status">
          <span>{live.toast.text}</span>
          <button type="button" className="gym-toast-close" onClick={live.dismissToast} aria-label="Dismiss">×</button>
        </div>
      )}
    </>
  );
}

// THE MIRROR OVER THE LOG (G8), and the only way back into a running session from the rooms it can
// be left from. Every tab is reachable mid-session on purpose — a lifter between sets has real
// reasons to open the log or fix a routine, and an app that locks them out is one they leave — and
// what makes that safe is that this band is drawn above every room while the session runs, so
// walking out of the logger can never mean losing it.
//
// G8 draws a second state here that is NOT built: at rest the band says "Not training now." over
// "Workouts start on your phone" and a link to an iPhone app. There is no iPhone app to send anybody
// to, so the web keeps its own Start button and draws no door that goes nowhere — the brief flags
// that door as the one thing in it that cannot ship yet. When the app lists, the resting band and
// the link land together and Start leaves the web.
function LiveBand({ live }) {
  const routine = routineNameOf(live.session);
  return (
    <a className="gym-resume" href="#/gym">
      <span className="gym-live-dot" aria-hidden="true" />
      <span className="gym-resume-text">
        {`Training now${routine ? ` · ${routine}` : ''}  ·  ${clockOf(live.elapsed)}  ·  ${setCountLabel(live.sets.length)}`}
      </span>
      <span className="gym-resume-go">Resume ›</span>
    </a>
  );
}

// Four columns here and four in the grid that lays them out (gym.css) — the count lives in two
// places and both have to move together, which is what this note is for.
function TabBar({ screen }) {
  return (
    <nav className="gym-tabs">
      <a className={screen === 'today' ? 'gym-tab is-on' : 'gym-tab'} href="#/gym">Today</a>
      <a className={screen === 'log' ? 'gym-tab is-on' : 'gym-tab'} href="#/gym/log">The log</a>
      <a className={screen === 'routines' ? 'gym-tab is-on' : 'gym-tab'} href={ROUTINES_HREF}>Routines</a>
      <a className={screen === 'stats' ? 'gym-tab is-on' : 'gym-tab'} href={STATS_HREF}>Stats</a>
    </nav>
  );
}

export default GymApp;
