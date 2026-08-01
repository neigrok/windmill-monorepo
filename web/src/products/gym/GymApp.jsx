// Gym — the training log's web surface, in the instrument skin. Phase 0 is the seam made real:
// the account door, the read-only log (canon G3) at #/gym and one session read whole at
// #/gym/session/<id>. The set logger is the next bet — Start is rendered but waits for it,
// because a session nothing can land in would be a trap, not a feature.

import React, { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { ProductSwitcher } from '../../shell/ProductSwitcher.jsx';
import { useAuth } from '../../shell/auth/AuthProvider.jsx';
import { AccountSeat } from '../../shell/auth/AccountSeat.jsx';
import { SignInDialog } from '../../shell/auth/SignInDialog.jsx';
import { requestMagicLink } from '../../shell/auth/AuthClient.js';
import { gymApi } from './gymApi.js';
import {
  dayLabel, durationLabel, groupByExercise, isFinished, routineNameOf,
  sessionHref, sessionIdOf, setCountLabel, timeLabel, whenLabel,
} from './log.js';
import './gym.css';

export function GymApp({ hash, openSignInSignal = 0 }) {
  const [signInOpen, setSignInOpen] = useState(false);
  const { user, status, signOut } = useAuth();
  const sessionId = sessionIdOf(hash);

  // An expired magic link asks the active product to open its own door (App.jsx bumps the signal).
  useEffect(() => {
    if (openSignInSignal > 0) setSignInOpen(true);
  }, [openSignInSignal]);

  return (
    <div className="gym-root" data-theme="dark">
      <div className="gym-seat">
        <AccountSeat
          user={user}
          status={status}
          onSignIn={() => setSignInOpen(true)}
          onSignOut={signOut}
          onSettings={() => { window.location.hash = '#/settings'; }}
          onConnect={() => { window.location.hash = '#/connect'; }}
        />
      </div>
      <main className="gym-column">
        {/* Three auth states, three rooms — a first visit resolves through 'loading' with no
            stored hint, and an empty room would read as a broken app. */}
        {status === 'loading' && <p className="gym-quiet">Opening the log…</p>}
        {status === 'ghost' && <SignInDoor onSignIn={() => setSignInOpen(true)} />}
        {status === 'signed-in' && (sessionId ? <SessionDetail id={sessionId} /> : <LogHome />)}
      </main>
      <div className="gym-switch">
        <ProductSwitcher current="gym" />
      </div>
      <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} onSend={requestMagicLink} />
    </div>
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

function LogHome() {
  const [log, setLog] = useState({ phase: 'loading', sessions: [] });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLog({ phase: 'loading', sessions: [] });
    gymApi.sessions()
      .then((sessions) => { if (live) setLog({ phase: 'ready', sessions }); })
      .catch(() => { if (live) setLog({ phase: 'failed', sessions: [] }); });
    return () => { live = false; };
  }, [attempt]);

  return (
    <>
      <header className="gym-head">
        <h1 className="gym-title">Training log</h1>
        <div className="gym-start">
          <button type="button" className="gym-start-button" disabled>Start session</button>
          <p className="gym-start-note">Waits for the set logger — it lands next.</p>
        </div>
      </header>
      {log.phase === 'loading' && <p className="gym-quiet">Opening the log…</p>}
      {log.phase === 'failed' && (
        <p className="gym-alarm">
          The log didn’t load.
          <button type="button" className="gym-retry" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </p>
      )}
      {log.phase === 'ready' && log.sessions.length === 0 && (
        <p className="gym-quiet">No sessions yet. The first one lands here when you log a set.</p>
      )}
      {log.phase === 'ready' && log.sessions.length > 0 && (
        <ul className="gym-sessions">
          {log.sessions.map((summary) => <SessionRow key={summary.id} summary={summary} />)}
        </ul>
      )}
    </>
  );
}

function SessionRow({ summary }) {
  const routine = routineNameOf(summary);
  const exercises = summary.exercises ?? [];
  const title = routine ?? (exercises.length > 0 ? exercises.join(' · ') : 'No sets');
  return (
    <li>
      <a className="gym-row" href={sessionHref(summary.id)}>
        <div className="gym-row-top">
          <span>{whenLabel(summary.startedAt)}</span>
          <span className={isFinished(summary) ? 'gym-row-length' : 'gym-row-open'}>
            {isFinished(summary) ? durationLabel(summary.startedAt, summary.finishedAt) : 'in progress'}
          </span>
        </div>
        <div className="gym-row-title">{title}</div>
        <div className="gym-row-meta">
          {setCountLabel(summary.setCount)}
          {routine && exercises.length > 0 && ` · ${exercises.join(' · ')}`}
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
        <a className="gym-back" href="#/gym"><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Log</a>
        <p className="gym-quiet">This session isn’t in your log.</p>
      </>
    );
  }
  if (view.phase === 'failed') {
    return (
      <>
        <a className="gym-back" href="#/gym"><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Log</a>
        <p className="gym-alarm">
          The session didn’t load.
          <button type="button" className="gym-retry" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </p>
      </>
    );
  }

  const { session, groups, names } = view;
  const routine = routineNameOf(session);
  return (
    <>
      <header className="gym-detail-head">
        <a className="gym-back" href="#/gym"><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Log</a>
        <h1 className="gym-title">{routine ?? dayLabel(session.startedAt)}</h1>
        <p className="gym-detail-when">
          {whenLabel(session.startedAt)}
          {isFinished(session) ? ` · ${durationLabel(session.startedAt, session.finishedAt)}` : ' · in progress'}
        </p>
      </header>
      {groups.length === 0 && <p className="gym-quiet">No sets in this session.</p>}
      {groups.map(([exerciseId, sets]) => (
        <section className="gym-exercise" key={exerciseId}>
          <h2 className="gym-exercise-name">{names.get(exerciseId) ?? exerciseId}</h2>
          <ul className="gym-sets">
            {sets.map((set) => (
              <li key={set.id} className={set.kind === 'warmup' ? 'gym-set gym-set-warmup' : 'gym-set'}>
                <span className="gym-set-number">{set.setNumber}</span>
                <span className="gym-set-load">{set.weightKg} kg × {set.reps}</span>
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
