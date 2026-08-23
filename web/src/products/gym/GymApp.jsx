import React from 'react';
import { ProductSwitcher } from '../../shell/ProductSwitcher.jsx';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { AccountSeat } from '../../shell/auth/AccountSeat.jsx';
import { useSignInDoor, useSignInDoorHost } from '../../shell/auth/SignInDoor.jsx';
import { AskRoom } from './ask/AskRoom.jsx';
import { ThreadDetail, ThreadsList } from './ask/Threads.jsx';
import { Backfill } from './Backfill.jsx';
import { ConnectLog } from './connect/ConnectLog.jsx';
import { FinishScreen } from './Finish.jsx';
import { LogList, SessionDetail } from './Log.jsx';
import { ProposalDiff } from './Proposals.jsx';
import { MovementRecord } from './Record.jsx';
import { RoutineEditor, RoutinesList } from './Routines.jsx';
import { Today } from './Today.jsx';
import {
  finishIdOf, movementIdOf, proposalIdOf, ROUTINES_HREF, routineIdOf, screenOf, sessionIdOf,
  sharedTokenOf, threadIdOf,
} from './log.js';
import { SharedSession } from './share/SharedSession.jsx';
import { useTrainingLog } from './useTrainingLog.js';
import './gym.css';

const TAB_SCREENS = ['today', 'log', 'routines'];

export function GymApp({ hash, inShell = false }) {
  const { user, status, signOut } = useAuth();
  const openSignInDoor = useSignInDoor();
  const lendDoorSkin = useSignInDoorHost();
  const sharedToken = sharedTokenOf(hash);
  // The token is the whole credential; this early return must stay below every hook.
  if (sharedToken) {
    return (
      <div className="gym-root" data-chrome={inShell ? 'shell' : 'own'} data-theme="dark" data-brand="gym">
        <SharedSession token={sharedToken} />
      </div>
    );
  }

  return (
    <div className="gym-root" ref={lendDoorSkin} data-chrome={inShell ? 'shell' : 'own'} data-theme="dark" data-brand="gym">
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
  const { refresh } = useAuth();
  // One instance only: a second doubles the boot read and the poll.
  const log = useTrainingLog({ onSignedOut: refresh });
  const screen = screenOf(hash);

  return (
    <>
      <Chrome inShell={inShell} user={user} status={status} onSignIn={onSignIn} onSignOut={onSignOut} />
      <main className="gym-column">
        {screen === 'today' && <Today log={log} onSignIn={onSignIn} />}
        {screen === 'log' && <LogList log={log} onSignIn={onSignIn} />}
        {screen === 'routines' && <RoutinesList log={log} />}
        {screen === 'record' && <MovementRecord id={movementIdOf(hash)} log={log} />}
        {screen === 'routine' && <RoutineEditor key={routineIdOf(hash)} id={routineIdOf(hash)} log={log} />}
        {screen === 'proposal' && <ProposalDiff key={proposalIdOf(hash)} id={proposalIdOf(hash)} log={log} />}
        {screen === 'session' && <SessionDetail key={sessionIdOf(hash)} id={sessionIdOf(hash)} log={log} />}
        {screen === 'finish' && <FinishScreen id={finishIdOf(hash)} log={log} />}
        {screen === 'backfill' && <Backfill log={log} />}
        {screen === 'ask' && <AskRoom log={log} />}
        {screen === 'threads' && <ThreadsList />}
        {screen === 'thread' && <ThreadDetail key={threadIdOf(hash)} id={threadIdOf(hash)} />}
        {screen === 'connect' && <ConnectLog />}
      </main>
      {TAB_SCREENS.includes(screen) && <TabBar screen={screen} />}
      {log.toast && (
        <div className="gym-toast" role="status">
          <span>{log.toast.text}</span>
          {log.toast.action && (
            <button
              type="button"
              className="gym-toast-undo"
              onClick={() => { log.toast.action.run(); log.dismissToast(); }}
            >
              {log.toast.action.label}
            </button>
          )}
          <button type="button" className="gym-toast-close" onClick={log.dismissToast} aria-label="Dismiss">×</button>
        </div>
      )}
    </>
  );
}

// Three columns here and three in the gym.css grid; they move together.
function TabBar({ screen }) {
  return (
    <nav className="gym-tabs">
      <a className={screen === 'today' ? 'gym-tab is-on' : 'gym-tab'} href="#/gym">Today</a>
      <a className={screen === 'log' ? 'gym-tab is-on' : 'gym-tab'} href="#/gym/log">The log</a>
      <a className={screen === 'routines' ? 'gym-tab is-on' : 'gym-tab'} href={ROUTINES_HREF}>Routines</a>
    </nav>
  );
}

export default GymApp;
