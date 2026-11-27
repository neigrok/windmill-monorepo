import React from 'react';
import { Toast } from '../../design-system/index.js';
import { useAppearance } from '../../shell/useAppearance.js';
import { ProductSwitcher } from '../../shell/ProductSwitcher.jsx';
import { navigate } from '../../shell/navigation.js';
import { useSyncReplica } from '../../platform/sync/react.js';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { AccountSeat } from '../../shell/auth/AccountSeat.jsx';
import { useSignInDoor, useSignInDoorHost } from '../../shell/auth/SignInDoor.jsx';
import { Backfill } from './backfill/Backfill.jsx';
import { BodyweightScreen } from './bodyweight/Bodyweight.jsx';
import { CoachDoor, CoachRoom } from './coach/CoachRoom.jsx';
import { HistoryPage } from './coach/History.jsx';
import { forgetRetiredCoach } from './coach/retiredCoach.js';
import { FinishScreen } from './Finish.jsx';
import { t } from './i18n/index.js';
import { LogList } from './Log.jsx';
import { Notes } from './notes/Notes.jsx';
import { MovementRecord } from './Record.jsx';
import { useRefusedStarts } from './recovery/InThisBrowser.jsx';
import { RoutineEditor, RoutinesList } from './Routines.jsx';
import { useGymSeat } from './seat.js';
import {
  backfillFromOf, backfillTargetOf, COACH_HREF, finishIdOf, fixSetIdOf, movementIdOf, proposalIdOf, recordFromOf, ROUTINES_HREF, routineIdOf, screenOf,
  sessionIdOf, sharedTokenOf, sharedLogTokenOf, threadIdOf,
} from './log.js';
import { LogShareScreen, SharedLogScreen } from './share/LogShare.jsx';
import { SharedSession } from './share/SharedSession.jsx';
import { useTrainingLog } from './useTrainingLog.js';
import { WorkoutPage } from './workout/Workout.jsx';
import { WorkoutBar } from './workout/WorkoutBar.jsx';
import { historyHref, historyQuery } from './logbook/history.js';
import './gym.css';

function tabOf(screen) {
  if (screen === 'workout') return null;
  if (['coach', 'thread', 'threads', 'notes'].includes(screen)) return 'coach';
  if (['log', 'session', 'finish', 'backfill', 'bodyweight', 'record', 'share-log'].includes(screen)) return 'log';
  return 'routines';
}

// Coach and Notes, in Coach's rail, stand behind an account the shell has settled (web-device-parity §2, §3).
const COACH_SCREENS = new Set(['coach', 'threads', 'thread', 'notes']);

// The screen a hash opens in this seat. A log share needs a settled account, and the past-workout form a replica that can
// send its command (R-5): signed out The log stands in their place, as their doors are not drawn there.
function screenIn(hash, { signedIn, anonymous }, status) {
  const screen = screenOf(hash);
  if (screen === 'share-log' && !signedIn && status === 'ghost') return 'log';
  if (screen === 'backfill' && anonymous) return 'log';
  return screen;
}

function columnClass(screen) {
  if (screen === 'coach' || screen === 'thread') return ' has-coach';
  if (['backfill', 'log', 'session', 'routine', 'record', 'share-log', 'notes', 'workout'].includes(screen)) return ' has-desk';
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

  // The replica this tab draws is the room, bound, its session paused or its account yet to answer, or the browser's own
  // copy signed out (spec §3); the room lives as long as its binding, through a re-identify.
  return (
    <div className="gym-root gym-skin" ref={lendDoorSkin} data-chrome={inShell ? 'shell' : 'own'} data-theme={theme} data-brand="gym">
      {replica
        ? <TrainingRoom key={replica.binding} hash={hash} inShell={inShell} user={user} status={status} onSignIn={openSignInDoor} onSignOut={signOut} />
        : <main className="gym-column"><Opening /></main>}
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

function Opening() {
  return <p className="gym-quiet">{t('gym.app.opening')}</p>;
}

// Shares, log shares, the connected log, Coach and Notes stay behind an account the shell has settled, online or offline
// from its last answer; until then Coach's tab is its door, or the opening line while the account has yet to answer. The
// rest draws from the replica, the browser's own copy signed out, and says nothing of where the work is kept (R-6).
function TrainingRoom({ hash, inShell, user, status, onSignIn, onSignOut }) {
  const { account } = useAuth();
  const seat = useGymSeat();
  const { signedIn, anonymous } = seat;
  const log = useTrainingLog();
  useRefusedStarts(log);
  const screen = screenIn(hash, seat, status);
  const waitsForAccount = !signedIn && (COACH_SCREENS.has(screen) || screen === 'share-log');
  const door = waitsForAccount && status === 'ghost';
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
        <main className={`gym-column${door ? ' has-door' : columnClass(screen)}`}>
          {(screen === 'routines' || screen === 'proposal') && <RoutinesList log={log} reviewing={screen === 'proposal' ? proposalIdOf(hash) : null} anonymous={anonymous} />}
          {(screen === 'log' || screen === 'session') && <LogList log={log} signedIn={signedIn} anonymous={anonymous} positions={historyPositions.current} pagePositions={pagePositions.current} hash={screen === 'log' ? hash : new URLSearchParams(hash.split('?').slice(1).join('?')).get('from') ?? '#/gym/log'} sessionId={screen === 'session' ? sessionIdOf(hash) : null} fixSetId={fixSetIdOf(hash)} edit={/^#\/gym\/session\/[^/?]+\/edit(?:\?|$)/.test(hash)} />}
          {screen === 'bodyweight' && <BodyweightScreen log={log} />}
          {screen === 'record' && <MovementRecord id={movementIdOf(hash)} from={recordFromOf(hash)} log={log} />}
          {screen === 'routine' && <RoutineEditor key={routineIdOf(hash)} id={routineIdOf(hash)} log={log} />}
          {screen === 'finish' && <FinishScreen id={finishIdOf(hash)} log={log} signedIn={signedIn} />}
          {screen === 'backfill' && <Backfill key={hash} target={backfillTargetOf(hash)} from={backfillFromOf(hash)} log={log} />}
          {waitsForAccount && (door ? <CoachDoor onSignIn={onSignIn} /> : <Opening />)}
          {signedIn && screen === 'coach' && <CoachRoom key={account?.id} log={log} />}
          {signedIn && screen === 'threads' && <HistoryPage key={account?.id} log={log} />}
          {signedIn && screen === 'thread' && <CoachRoom key={account?.id} log={log} threadId={threadIdOf(hash)} />}
          {signedIn && screen === 'notes' && <Notes log={log} />}
          {signedIn && screen === 'share-log' && <LogShareScreen />}
          {screen === 'workout' && <WorkoutPage hash={hash} log={log} signedIn={signedIn} />}
        </main>
      </div>
      <WorkoutBar onPage={screen === 'workout'} />
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
