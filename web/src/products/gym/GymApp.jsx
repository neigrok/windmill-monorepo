import React from 'react';
import { Button, Toast } from '../../design-system/index.js';
import { useAppearance } from '../../shell/useAppearance.js';
import { ProductSwitcher } from '../../shell/ProductSwitcher.jsx';
import { navigate } from '../../shell/navigation.js';
import { useSyncReplica } from '../../platform/sync/react.js';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { AccountSeat } from '../../shell/auth/AccountSeat.jsx';
import { useSignInDoor, useSignInDoorHost } from '../../shell/auth/SignInDoor.jsx';
import { Backfill } from './backfill/Backfill.jsx';
import { BodyweightScreen } from './bodyweight/Bodyweight.jsx';
import { CoachRoom } from './coach/CoachRoom.jsx';
import { HistoryPage } from './coach/History.jsx';
import { forgetRetiredCoach } from './coach/retiredCoach.js';
import { FinishScreen } from './Finish.jsx';
import { t } from './i18n/index.js';
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
  if (['backfill', 'log', 'session', 'routine', 'record', 'share-log', 'notes'].includes(screen)) return ' has-desk';
  return '';
}

export function GymApp({ hash, inShell = false }) {
  const { user, status, signOut } = useAuth();
  const replica = useSyncReplica();
  const { resolved: theme } = useAppearance();
  const openSignInDoor = useSignInDoor();
  const lendDoorSkin = useSignInDoorHost();
  const legacyConnect = /^#\/gym\/connect(\/|$|\?)/.test(hash || '');
  React.useEffect(() => { forgetRetiredCoach(); }, []);
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

  // The replica decides: a bound one is the room, its session paused or its account yet to answer; the anon one is the pitch.
  const door = replica?.state === 'bound' ? 'room' : replica && status === 'ghost' ? 'pitch' : 'opening';
  return (
    <div className="gym-root gym-skin" ref={lendDoorSkin} data-chrome={inShell ? 'shell' : 'own'} data-theme={theme} data-brand="gym">
      {door === 'opening' && <main className="gym-column"><p className="gym-quiet">{t('gym.app.opening')}</p></main>}
      {door === 'pitch' && (
        <>
          <Chrome inShell={inShell} user={user} status={status} onSignIn={openSignInDoor} onSignOut={signOut} />
          <main className="gym-column"><SignInPitch onSignIn={openSignInDoor} /></main>
        </>
      )}
      {door === 'room' && (
        <TrainingRoom key={replica.id} hash={hash} inShell={inShell} user={user} status={status} onSignIn={openSignInDoor} onSignOut={signOut} />
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
      <h1 className="gym-title">{t('gym.app.doorTitle')}</h1>
      <p className="gym-door-line">{t('gym.app.doorLine')}</p>
      <Button onClick={onSignIn}>{t('gym.app.signIn')}</Button>
    </section>
  );
}

// Shares, log shares, the connected log and Coach stay behind a confirmed account; the rest draws from the replica.
function TrainingRoom({ hash, inShell, user, status, onSignIn, onSignOut }) {
  const { account } = useAuth();
  const signedIn = status === 'signed-in';
  const log = useTrainingLog();
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
          {(screen === 'routines' || screen === 'proposal') && <RoutinesList log={log} reviewing={screen === 'proposal' ? proposalIdOf(hash) : null} />}
          {(screen === 'log' || screen === 'session') && <LogList log={log} signedIn={signedIn} positions={historyPositions.current} pagePositions={pagePositions.current} hash={screen === 'log' ? hash : new URLSearchParams(hash.split('?').slice(1).join('?')).get('from') ?? '#/gym/log'} sessionId={screen === 'session' ? sessionIdOf(hash) : null} fixSetId={fixSetIdOf(hash)} edit={/^#\/gym\/session\/[^/?]+\/edit(?:\?|$)/.test(hash)} />}
          {screen === 'bodyweight' && <BodyweightScreen log={log} />}
          {screen === 'record' && <MovementRecord id={movementIdOf(hash)} from={recordFromOf(hash)} log={log} />}
          {screen === 'routine' && <RoutineEditor key={routineIdOf(hash)} id={routineIdOf(hash)} log={log} />}
          {screen === 'finish' && <FinishScreen id={finishIdOf(hash)} log={log} signedIn={signedIn} />}
          {screen === 'backfill' && <Backfill key={hash} target={backfillTargetOf(hash)} from={backfillFromOf(hash)} log={log} />}
          {signedIn && screen === 'coach' && <CoachRoom key={account?.id} log={log} />}
          {signedIn && screen === 'threads' && <HistoryPage key={account?.id} log={log} />}
          {signedIn && screen === 'thread' && <CoachRoom key={account?.id} log={log} threadId={threadIdOf(hash)} />}
          {screen === 'notes' && <Notes log={log} />}
          {signedIn && screen === 'share-log' && <LogShareScreen />}
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
  return <nav className="gym-tabs" aria-label={t('gym.app.tabs')}>
    {[
      { label: t('gym.app.tabRoutines'), href: ROUTINES_HREF, screen: 'routines' },
      { label: t('gym.app.tabLog'), href: '#/gym/log', screen: 'log' },
      { label: t('gym.app.tabCoach'), href: COACH_HREF, screen: 'coach' },
    ].map((tab) => <a key={tab.screen} href={tab.href} aria-current={screen === tab.screen ? 'page' : undefined}>{tab.label}</a>)}
  </nav>;
}

export default GymApp;
