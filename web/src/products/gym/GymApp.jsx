// Gym — the training log's web surface, in the instrument skin. This file is the frame and none of
// the rooms: it resolves the account, holds the ONE read of the log every room shares, and hands
// each hash to the screen that answers it (Today · The log · Routines · Statistics, plus one
// session, one routine, one review and the past-workout door).
//
// The web is the mirror and the desk, never the capture surface: workouts start on the phone, Today
// mirrors the one that is running read-only (§11.2), and the only write door here is the backfill.
// Nothing here decides anything: the rules live in log.js, routines.js, review.js, stats.js,
// backfill.js and share/.
//
// `inShell` is the one thing the frame is told rather than works out: whether this is the bare
// surface at #/gym or a room inside the /app chrome. The route table decides it off the pathname
// it was handed (routes.js), because the shell resolves the room in the same render that mounts
// this component and a pathname read from in here can still be the pre-upgrade one.

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
  finishIdOf, ROUTINES_HREF, routineIdOf, screenOf, sessionIdOf, sharedTokenOf, STATS_HREF,
} from './log.js';
import { SharedSession } from './share/SharedSession.jsx';
import { useTrainingLog } from './useTrainingLog.js';
import './gym.css';

// The four rooms a lifter navigates between. Everything else — a session, a routine, the review,
// the backfill form — is somewhere they went from one of them, and each carries its own way back.
const TAB_SCREENS = ['today', 'log', 'routines', 'stats'];

export function GymApp({ hash, inShell = false }) {
  const { user, status, signOut } = useAuth();
  const openSignInDoor = useSignInDoor();
  const lendDoorSkin = useSignInDoorHost();
  const sharedToken = sharedTokenOf(hash);
  // The root names its own scope so gym is basalt-and-iris wherever it mounts (styles/tokens/
  // palettes.css). Inside the /app shell that repeats what the shell already stamped; at #/gym and
  // on the coach's shared page nothing above this element paints anything, and without it the room
  // would read the family's night and the family's terracotta instead of its own.

  // THE COACH'S PAGE, ANSWERED BEFORE THE ACCOUNT IS. The token in the URL is the whole credential,
  // so this branch reads no auth state, waits for none, and offers no door back into the app: a
  // person opening a link somebody sent them is a reader of one workout and not a lapsed lifter to
  // be recovered. Every hook above runs first, unconditionally — the early return is under them,
  // never between them.
  if (sharedToken) {
    return (
      <div className="gym-root" data-chrome={inShell ? 'shell' : 'own'} data-theme="dark" data-brand="gym">
        <SharedSession token={sharedToken} />
      </div>
    );
  }

  return (
    <div className="gym-root" ref={lendDoorSkin} data-chrome={inShell ? 'shell' : 'own'} data-theme="dark" data-brand="gym">
      {/* Three auth states, three answers — a first visit resolves through 'loading' with no stored
          hint, and an empty screen would read as a broken app. */}
      {status === 'loading' && <main className="gym-column"><p className="gym-quiet">Opening the log…</p></main>}
      {status === 'ghost' && (
        <>
          <Chrome inShell={inShell} user={user} status={status} onSignIn={openSignInDoor} onSignOut={signOut} />
          <main className="gym-column"><SignInPitch onSignIn={openSignInDoor} /></main>
        </>
      )}
      {status === 'signed-in' && (
        <TrainingRoom hash={hash} inShell={inShell} user={user} status={status} onSignIn={openSignInDoor} onSignOut={signOut} />
      )}
    </div>
  );
}

// THE FURNITURE A BARE SURFACE HAS TO BRING, and only a bare surface. At #/gym nothing above this
// component paints anything at all, so the room floats the two pieces every Windmill room needs: the
// account seat, and the switcher between products. Inside the /app shell both of those already
// exist in its head — the switcher centred, the seat opposite it — so drawing them here would put a
// second account seat on the screen beside the first.
//
// The switcher answers this for itself off the pathname and would render null under /app regardless;
// the seat cannot, because it is the very component the shell's own chrome is made of. So the room
// asks once, here, for both — and the question is answered where the frame is resolved (routes.js),
// never by reading the location from inside a render.
function Chrome({ inShell, user, status, onSignIn, onSignOut }) {
  if (inShell) return null;
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

function TrainingRoom({ hash, inShell, user, status, onSignIn, onSignOut }) {
  // ONE instance, and every room reads the mirrored session, the catalog and the log off it. A
  // second would mean a second boot read and a second poll over the same open session.
  const log = useTrainingLog();
  const screen = screenOf(hash);

  return (
    <>
      <Chrome inShell={inShell} user={user} status={status} onSignIn={onSignIn} onSignOut={onSignOut} />
      <main className="gym-column">
        {screen === 'today' && <Today log={log} />}
        {screen === 'log' && <LogList log={log} />}
        {screen === 'routines' && <RoutinesList log={log} />}
        {screen === 'stats' && <Stats />}
        {/* KEYED BY THE DOCUMENT IT EDITS. The editor holds a DRAFT of one routine, and a draft
            may not outlive the routine it is of: the key is what makes React drop the instance
            when the hash moves to another one. The editor's own Duplicate button moves it — and
            without the key the copy's URL would be drawn over the original's unsaved edits, and
            Done would whole-document PUT them back onto the original. */}
        {screen === 'routine' && <RoutineEditor key={routineIdOf(hash)} id={routineIdOf(hash)} log={log} />}
        {screen === 'session' && <SessionDetail id={sessionIdOf(hash)} />}
        {screen === 'finish' && <FinishScreen id={finishIdOf(hash)} log={log} />}
        {screen === 'backfill' && <Backfill log={log} />}
      </main>
      {TAB_SCREENS.includes(screen) && <TabBar screen={screen} />}
      {log.toast && (
        <div className="gym-toast" role="status">
          <span>{log.toast.text}</span>
          <button type="button" className="gym-toast-close" onClick={log.dismissToast} aria-label="Dismiss">×</button>
        </div>
      )}
    </>
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
