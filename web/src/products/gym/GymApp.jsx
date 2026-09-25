import React from 'react';
import { Button, Toast } from '../../design-system/index.js';
import { useAppearance } from '../../shell/useAppearance.js';
import { ProductSwitcher } from '../../shell/ProductSwitcher.jsx';
import { navigate } from '../../shell/navigation.js';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { AccountSeat } from '../../shell/auth/AccountSeat.jsx';
import { useSignInDoor, useSignInDoorHost } from '../../shell/auth/SignInDoor.jsx';
import { Backfill } from './backfill/Backfill.jsx';
import { BodyweightScreen } from './bodyweight/Bodyweight.jsx';
import { CoachRoom } from './coach/CoachRoom.jsx';
import { ThreadDetail, ThreadsList } from './coach/Threads.jsx';
import { FinishScreen } from './Finish.jsx';
import { LogList } from './Log.jsx';
import { Notes } from './notes/Notes.jsx';
import { MovementRecord } from './Record.jsx';
import { RoutineEditor, RoutinesList } from './Routines.jsx';
import {
  backfillFromOf, backfillTargetOf, COACH_HREF, finishIdOf, fixSetIdOf, movementIdOf, proposalIdOf, recordFromOf, ROUTINES_HREF, routineIdOf, screenOf,
  sessionIdOf, sharedTokenOf, sharedLogTokenOf, threadIdOf,
} from './log.js';
import { LogShareScreen, SharedLogScreen } from './share/LogShare.jsx';
import { SharedSession } from './share/SharedSession.jsx';
import { useTrainingLog } from './useTrainingLog.js';
import { historyHref, historyQuery } from './logbook/history.js';
import './gym.css';

function tabOf(screen) {
  if (['coach', 'thread', 'threads', 'notes'].includes(screen)) return 'coach';
  if (['log', 'session', 'finish', 'backfill', 'bodyweight', 'record', 'share-log'].includes(screen)) return 'log';
  return 'routines';
}

function columnClass(screen) {
  if (screen === 'coach' || screen === 'thread') return ' has-coach';
  if (['backfill', 'log', 'session', 'routine', 'record', 'share-log'].includes(screen)) return ' has-desk';
  return '';
}

export function GymApp({ hash, inShell = false }) {
  const { user, status, signOut } = useAuth();
  const { resolved: theme } = useAppearance();
  const openSignInDoor = useSignInDoor();
  const lendDoorSkin = useSignInDoorHost();
  const legacyConnect = /^#\/gym\/connect(\/|$|\?)/.test(hash || '');
  React.useEffect(() => {
    if (legacyConnect) navigate('/app/connect', { replace: true });
  }, [legacyConnect]);
  const sharedToken = sharedTokenOf(hash);
  const sharedLogToken = sharedLogTokenOf(hash);
  if (legacyConnect) return null;
  // The token is the whole credential; this early return must stay below every hook.
  if (sharedToken || sharedLogToken) {
    return (
      <div className="gym-root gym-skin" data-chrome={inShell ? 'shell' : 'own'} data-theme={theme} data-brand="gym">
        {sharedLogToken ? <SharedLogScreen token={sharedLogToken} hash={hash} /> : <SharedSession token={sharedToken} />}
      </div>
    );
  }

  return (
    <div className="gym-root gym-skin" ref={lendDoorSkin} data-chrome={inShell ? 'shell' : 'own'} data-theme={theme} data-brand="gym">
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
      <header className="gym-own-header"><div className="gym-own-seat">
        <AccountSeat
          user={user}
          display="label"
          status={status}
          onSignIn={onSignIn}
          onSignOut={onSignOut}
          onSettings={() => { window.location.hash = '#/settings'; }}
          onConnect={() => { window.location.hash = '#/connect'; }}
        />
      </div>
      <div className="gym-own-switch">
        <ProductSwitcher current="gym" />
      </div></header>
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
  const { refresh, account } = useAuth();
  // One instance only: a second doubles the boot read and the poll.
  const log = useTrainingLog({ onSignedOut: refresh });
  const screen = screenOf(hash);
  const historyPositions = React.useRef(new Map());
  const pagePositions = React.useRef(new Map());
  const content = React.useRef(null);
  const pageKey = screen === 'log' ? historyHref(historyQuery(hash), { selected: null }) : hash.split('?')[0];
  React.useLayoutEffect(() => {
    const page = content.current;
    if (!page) return;
    page.scrollTop = 0;
  }, [pageKey, screen]);

  return (
    <div className="gym-room">
      <Chrome inShell={inShell} user={user} status={status} onSignIn={onSignIn} onSignOut={onSignOut} />
      <div ref={content} className="gym-scroll">
        <main className={`gym-column${columnClass(screen)}`}>
          {(screen === 'routines' || screen === 'proposal') && <RoutinesList log={log} onSignIn={onSignIn} reviewing={screen === 'proposal' ? proposalIdOf(hash) : null} />}
          {(screen === 'log' || screen === 'session') && <LogList log={log} positions={historyPositions.current} pagePositions={pagePositions.current} onSignIn={onSignIn} hash={screen === 'log' ? hash : new URLSearchParams(hash.split('?').slice(1).join('?')).get('from') ?? '#/gym/log'} sessionId={screen === 'session' ? sessionIdOf(hash) : null} fixSetId={fixSetIdOf(hash)} edit={/^#\/gym\/session\/[^/?]+\/edit(?:\?|$)/.test(hash)} />}
          {screen === 'bodyweight' && <BodyweightScreen log={log} />}
          {screen === 'record' && <MovementRecord id={movementIdOf(hash)} from={recordFromOf(hash)} log={log} />}
          {screen === 'routine' && <RoutineEditor key={routineIdOf(hash)} id={routineIdOf(hash)} log={log} />}
          {screen === 'finish' && <FinishScreen id={finishIdOf(hash)} log={log} />}
          {screen === 'backfill' && <Backfill key={hash} target={backfillTargetOf(hash)} from={backfillFromOf(hash)} log={log} />}
          {screen === 'coach' && <CoachRoom key={account?.id} log={log} accountId={account?.id} />}
          {screen === 'threads' && <ThreadsList log={log} accountId={account?.id} />}
          {screen === 'thread' && <ThreadDetail key={`${account?.id}-${threadIdOf(hash)}`} id={threadIdOf(hash)} log={log} accountId={account?.id} />}
          {screen === 'notes' && <Notes log={log} />}
          {screen === 'share-log' && <LogShareScreen log={log} />}
        </main>
      </div>
      <TabBar screen={tabOf(screen)} />
      <Transient transient={log.transient} />
    </div>
  );
}

// Keep the live region mounted so Undo and announcements survive screen changes.
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

function TabBar({ screen }) {
  return <nav className="gym-tabs" aria-label="Gym">
    {[
      { label: 'Routines', href: ROUTINES_HREF, screen: 'routines' },
      { label: 'The log', href: '#/gym/log', screen: 'log' },
      { label: 'Coach', href: COACH_HREF, screen: 'coach' },
    ].map((tab) => <a key={tab.screen} href={tab.href} aria-current={screen === tab.screen ? 'page' : undefined}>{tab.label}</a>)}
  </nav>;
}

export default GymApp;
