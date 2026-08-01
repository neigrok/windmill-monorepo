// Gym — the training log's web surface, in the instrument skin. Three rooms behind one door:
// Today (start a session, or the live logger itself), The log (read-only, newest first) and one
// session read whole. The live session IS workout mode — while it runs the tabs and the shell's own
// chrome are not drawn, the only ways out are Finish and the resume banner, and the screen is held
// awake. Nothing here decides anything: the rules live in log.js and logger/.

import React, { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { ProductSwitcher } from '../../shell/ProductSwitcher.jsx';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { AccountSeat } from '../../shell/auth/AccountSeat.jsx';
import { SignInDialog } from '../../shell/auth/SignInDialog.jsx';
import { requestMagicLink } from '../../shell/auth/AuthClient.js';
import { gymApi } from './gymApi.js';
import {
  clockOf, dayLabel, durLabel, fmt, groupByExercise, isFinished, nameOfMovement, routineNameOf,
  screenOf, sessionHref, sessionIdOf, sessionMetaLabel, setCountLabel, timeLabel, whenLabel,
} from './log.js';
import { Logger } from './logger/Logger.jsx';
import { useLiveSession } from './logger/useLiveSession.js';
import './gym.css';

export function GymApp({ hash, openSignInSignal = 0 }) {
  const [signInOpen, setSignInOpen] = useState(false);
  const { user, status, signOut } = useAuth();

  // An expired magic link asks the active product to open its own door (App.jsx bumps the signal).
  useEffect(() => {
    if (openSignInSignal > 0) setSignInOpen(true);
  }, [openSignInSignal]);

  return (
    <div className="gym-root" data-theme="dark">
      {/* Three auth states, three rooms — a first visit resolves through 'loading' with no stored
          hint, and an empty room would read as a broken app. */}
      {status === 'loading' && <main className="gym-column"><p className="gym-quiet">Opening the log…</p></main>}
      {status === 'ghost' && (
        <>
          <Chrome user={user} status={status} onSignIn={() => setSignInOpen(true)} onSignOut={signOut} />
          <main className="gym-column"><SignInDoor onSignIn={() => setSignInOpen(true)} /></main>
        </>
      )}
      {status === 'signed-in' && (
        <TrainingRoom hash={hash} user={user} status={status} onSignIn={() => setSignInOpen(true)} onSignOut={signOut} />
      )}
      <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} onSend={requestMagicLink} />
    </div>
  );
}

function Chrome({ user, status, onSignIn, onSignOut }) {
  return (
    <>
      <div className="gym-seat">
        <AccountSeat
          user={user}
          status={status}
          onSignIn={onSignIn}
          onSignOut={onSignOut}
          onSettings={() => { window.location.hash = '#/settings'; }}
          onConnect={() => { window.location.hash = '#/connect'; }}
        />
      </div>
      <div className="gym-switch">
        <ProductSwitcher current="gym" />
      </div>
    </>
  );
}

function SignInDoor({ onSignIn }) {
  return (
    <section className="gym-door">
      <h1 className="gym-title">Training log</h1>
      <p className="gym-door-line">Sign in to open your training log.</p>
      <button type="button" className="gym-door-button" onClick={onSignIn}>Sign in</button>
    </section>
  );
}

function TrainingRoom({ hash, user, status, onSignIn, onSignOut }) {
  const live = useLiveSession();
  const screen = screenOf(hash);
  const sessionId = sessionIdOf(hash);
  const logging = live.phase === 'live' && screen === 'today';

  return (
    <>
      {!logging && <Chrome user={user} status={status} onSignIn={onSignIn} onSignOut={onSignOut} />}
      {logging && <Logger live={live} />}
      {!logging && (
        <main className="gym-column">
          {screen === 'session' && <SessionDetail id={sessionId} />}
          {screen === 'log' && <LogList live={live} />}
          {screen === 'today' && <StartScreen live={live} />}
        </main>
      )}
      {!logging && screen !== 'session' && <TabBar screen={screen} />}
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

function TabBar({ screen }) {
  return (
    <nav className="gym-tabs">
      <a className={screen === 'today' ? 'gym-tab is-on' : 'gym-tab'} href="#/gym">Today</a>
      <a className={screen === 'log' ? 'gym-tab is-on' : 'gym-tab'} href="#/gym/log">The log</a>
    </nav>
  );
}

// No session running. One card per way in — and with no routines yet, that is the ad-hoc start:
// the log has no plan to snapshot, and pretending otherwise would be a promise the product can't keep.
function StartScreen({ live }) {
  if (live.phase === 'loading') return <p className="gym-quiet">Opening the log…</p>;
  if (live.phase === 'failed') return <p className="gym-read-failed">The log didn’t load. Open it again when you have signal.</p>;
  return (
    <section className="gym-start-screen">
      <h1 className="gym-title">Today</h1>
      <p className="gym-quiet">Nothing running. Start where you left off.</p>
      <button type="button" className="gym-start-adhoc" onClick={live.start}>Start without a routine</button>
      {live.summaries.length > 0 && (
        <p className="gym-start-last">
          {`Last trained ${dayLabel(live.summaries[0].startedAt)} · ${setCountLabel(live.summaries[0].setCount ?? 0)}`}
        </p>
      )}
    </section>
  );
}

function LogList({ live }) {
  const { phase, summaries, session, elapsed, sets } = live;
  return (
    <>
      <header className="gym-head">
        <h1 className="gym-title">The log</h1>
      </header>
      {session && (
        <a className="gym-resume" href="#/gym">
          <span className="gym-live-dot" aria-hidden="true" />
          <span className="gym-resume-text">
            {`${routineNameOf(session) ?? 'Ad-hoc session'}  ·  ${clockOf(elapsed)}  ·  ${setCountLabel(sets.length)}`}
          </span>
          <span className="gym-resume-go">Resume ›</span>
        </a>
      )}
      {phase === 'loading' && <p className="gym-quiet">Opening the log…</p>}
      {phase === 'failed' && <p className="gym-read-failed">The log didn’t load. Open it again when you have signal.</p>}
      {phase !== 'loading' && phase !== 'failed' && summaries.length === 0 && (
        <>
          <p className="gym-quiet">No sessions yet.</p>
          <p className="gym-quiet">The first one you log lands here, newest first.</p>
        </>
      )}
      {summaries.length > 0 && (
        <ul className="gym-sessions">
          {summaries.map((summary) => <SessionRow key={summary.id} summary={summary} />)}
        </ul>
      )}
    </>
  );
}

function SessionRow({ summary }) {
  const routine = routineNameOf(summary);
  const exercises = summary.exercises ?? [];
  return (
    <li>
      <a className="gym-row" href={sessionHref(summary.id)}>
        <div className="gym-row-top">
          <span>{whenLabel(summary.startedAt)}</span>
          <span className={isFinished(summary) ? 'gym-row-length' : 'gym-row-open'}>
            {isFinished(summary) ? durLabel(summary.finishedAt - summary.startedAt) : 'in progress'}
          </span>
        </div>
        <div className={routine ? 'gym-row-title' : 'gym-row-title is-adhoc'}>{routine ?? 'Ad-hoc'}</div>
        <div className="gym-row-meta">
          {setCountLabel(summary.setCount ?? 0)}
          {exercises.length > 0 && `   ·   ${exercises.join('   ·   ')}`}
        </div>
      </a>
    </li>
  );
}

function SessionDetail({ id }) {
  const [view, setView] = useState({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setView({ phase: 'loading' });
    Promise.all([gymApi.session(id), gymApi.exercises()])
      .then(([detail, catalog]) => {
        if (!live) return;
        if (!detail) {
          setView({ phase: 'absent' });
          return;
        }
        setView({
          phase: 'ready',
          session: detail.session,
          count: detail.sets.length,
          groups: groupByExercise(detail.sets),
          names: new Map(catalog.map((exercise) => [exercise.id, exercise.name])),
        });
      })
      .catch(() => { if (live) setView({ phase: 'failed' }); });
    return () => { live = false; };
  }, [id, attempt]);

  if (view.phase === 'loading') return <p className="gym-quiet">Opening the session…</p>;
  if (view.phase === 'absent') {
    return (
      <>
        <a className="gym-back" href="#/gym/log"><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Log</a>
        <p className="gym-quiet">This session isn’t in your log.</p>
      </>
    );
  }
  if (view.phase === 'failed') {
    return (
      <>
        <a className="gym-back" href="#/gym/log"><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Log</a>
        <p className="gym-read-failed">
          The session didn’t load.
          <button type="button" className="gym-retry" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </p>
      </>
    );
  }

  const { session, count, groups, names } = view;
  const routine = routineNameOf(session);
  return (
    <>
      <header className="gym-detail-head">
        <a className="gym-back" href="#/gym/log"><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Log</a>
        <h1 className="gym-title">
          {dayLabel(session.startedAt)}
          <span className="gym-detail-routine">{`  ·  ${routine ?? 'Ad-hoc'}`}</span>
        </h1>
        <p className="gym-detail-when">{sessionMetaLabel(session, count)}</p>
      </header>
      {groups.length === 0 && <p className="gym-quiet">No sets in this session.</p>}
      {groups.map(([exerciseId, sets]) => (
        <section className="gym-exercise" key={exerciseId}>
          <h2 className="gym-exercise-name">{names.get(exerciseId) ?? exerciseId}</h2>
          <ul className="gym-sets">
            {sets.map((set) => (
              <li key={set.id} className={set.kind === 'warmup' ? 'gym-set gym-set-warmup' : 'gym-set'}>
                <span className="gym-set-number">{set.setNumber}</span>
                <span className="gym-set-load">{`${fmt(set.weightKg)} × ${set.reps}`}</span>
                {set.kind !== 'working' && <span className="gym-set-kind">{set.kind}</span>}
                {set.rpe != null && <span className="gym-set-rpe">rpe {set.rpe}</span>}
                <span className="gym-set-time">{timeLabel(set.completedAt)}</span>
                {set.note && <span className="gym-set-note">{set.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

export default GymApp;
