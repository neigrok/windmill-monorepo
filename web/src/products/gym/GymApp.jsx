import React from 'react';
import { Button, TabRail, Toast } from '../../design-system/index.js';
import { ProductSwitcher } from '../../shell/ProductSwitcher.jsx';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { AccountSeat } from '../../shell/auth/AccountSeat.jsx';
import { useSignInDoor, useSignInDoorHost } from '../../shell/auth/SignInDoor.jsx';
import { Backfill } from './Backfill.jsx';
import { BodyweightScreen } from './bodyweight/Bodyweight.jsx';
import { CoachRoom } from './coach/CoachRoom.jsx';
import { ThreadDetail, ThreadsList } from './coach/Threads.jsx';
import { ConnectLog } from './connect/ConnectLog.jsx';
import { FinishScreen } from './Finish.jsx';
import { LogList, SessionDetail } from './Log.jsx';
import { Notes } from './notes/Notes.jsx';
import { MovementRecord } from './Record.jsx';
import { RoutineEditor, RoutinesList } from './Routines.jsx';
import {
  COACH_HREF, finishIdOf, movementIdOf, proposalIdOf, ROUTINES_HREF, routineIdOf, screenOf,
  sessionIdOf, sharedTokenOf, threadIdOf,
} from './log.js';
import { SharedSession } from './share/SharedSession.jsx';
import { useTrainingLog } from './useTrainingLog.js';
import './gym.css';

const TAB_SCREENS = ['routines', 'log', 'coach'];

// A routable proposal opens its dialog over the routines home, so the bar under it is the home's.
function tabOf(screen) {
  return screen === 'proposal' ? 'routines' : screen;
}

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
      <Button onClick={onSignIn}>Sign in</Button>
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
        {/* An external link's proposal is the home's to open: its dialog settles into the home's own read. */}
        {tabOf(screen) === 'routines' && <RoutinesList log={log} onSignIn={onSignIn} reviewing={screen === 'proposal' ? proposalIdOf(hash) : null} />}
        {screen === 'log' && <LogList log={log} onSignIn={onSignIn} />}
        {screen === 'bodyweight' && <BodyweightScreen log={log} />}
        {screen === 'record' && <MovementRecord id={movementIdOf(hash)} log={log} />}
        {screen === 'routine' && <RoutineEditor key={routineIdOf(hash)} id={routineIdOf(hash)} log={log} />}
        {screen === 'session' && <SessionDetail key={sessionIdOf(hash)} id={sessionIdOf(hash)} log={log} />}
        {screen === 'finish' && <FinishScreen id={finishIdOf(hash)} log={log} />}
        {screen === 'backfill' && <Backfill log={log} />}
        {screen === 'coach' && <CoachRoom log={log} />}
        {screen === 'threads' && <ThreadsList log={log} />}
        {screen === 'thread' && <ThreadDetail key={threadIdOf(hash)} id={threadIdOf(hash)} log={log} />}
        {screen === 'notes' && <Notes log={log} />}
        {screen === 'connect' && <ConnectLog />}
      </main>
      {TAB_SCREENS.includes(tabOf(screen)) && <TabBar screen={tabOf(screen)} />}
      <Transient transient={log.transient} />
    </>
  );
}

// The room's one transient, hosted here and not by a screen, so a withheld delete's Undo follows the
// lifter wherever they go next. Undo does not close it: it re-reads for whatever the window is still
// holding. The detail is a second field beside the sentence and never folded into it — `Toast` puts
// its children in one bare span, where a newline would collapse to a space and run the two together.
//
// The slot stands whether or not there is a sentence in it: a live region injected in the same
// commit as its content is a region a reader may never announce, and the deletes routed here close
// the editor or the sheet they were taken in, so this is the only place their way back is drawn.
export function Transient({ transient }) {
  return (
    <div className="gym-toast-slot" role="status">
      {transient && (
        <Toast
          tone="neutral"
          onClose={transient.dismiss ?? undefined}
          action={transient.action && {
            label: transient.action.label,
            onClick: transient.action.run,
          }}
        >
          <>
            {transient.text}
            {transient.detail && (
              <span className="gym-transient-detail">{transient.detail}</span>
            )}
          </>
        </Toast>
      )}
    </div>
  );
}

// The three rooms, in the design system's rail — which reserves its own height, so no screen under
// it has to know how tall it is. The list here is the only place the room count is stated.
function TabBar({ screen }) {
  return (
    <TabRail
      label="Gym"
      items={[
        { label: 'Routines', href: ROUTINES_HREF, active: screen === 'routines' },
        { label: 'The log', href: '#/gym/log', active: screen === 'log' },
        { label: 'Coach', href: COACH_HREF, active: screen === 'coach' },
      ]}
    />
  );
}

export default GymApp;
