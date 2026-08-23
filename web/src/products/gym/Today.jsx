import React, { useEffect, useState } from 'react';
import {
  clockOf, dayLabel, durLabel, fmt, isFinished, nameOfMovement, NEW_ROUTINE_ID, NO_ROUTINE,
  recordHref, routineHref, routineNameOf, sessionHref, setCountLabel,
} from './log.js';
import { AskDoor } from './ask/AskRoom.jsx';
import { LogNotOpen } from './Log.jsx';
import { PendingProposals } from './Proposals.jsx';
import { restLabel } from './settings/preferences.js';

const BEAT_MS = 500;

export function Today({ log, onSignIn }) {
  if (log.phase === 'loading') return <p className="gym-quiet">Opening the log…</p>;
  if (log.phase === 'failed') return <LogNotOpen log={log} onSignIn={onSignIn} />;

  const last = log.summaries.find(isFinished) ?? null;

  return (
    <section className="gym-today-screen">
      <h1 className="gym-title">Today</h1>

      {log.session && (
        <TrainingNow
          session={log.session}
          sets={log.sets}
          catalog={log.catalog}
          restSeconds={log.preferences.restSeconds}
        />
      )}
      {!log.session && (
        <>
          <p className="gym-today-line">Not training now.</p>
          <p className="gym-quiet">Workouts start on your phone.</p>
          {log.summaries.length === 0 && <FirstRun />}
        </>
      )}

      <PendingProposals />

      {last && (
        <section className="gym-last">
          <h2 className="gym-last-head">Last session</h2>
          <a className="gym-last-row" href={sessionHref(last.id)}>
            <span className="gym-last-name">{routineNameOf(last) ?? NO_ROUTINE}</span>
            <span className="gym-last-meta">
              {`${dayLabel(last.startedAt)}  ·  ${setCountLabel(last.setCount ?? 0)}  ·  ${durLabel(last.finishedAt - last.startedAt)}`}
            </span>
            <span className="gym-last-go" aria-hidden="true">›</span>
          </a>
        </section>
      )}

      <AskDoor training={log.session != null} />
    </section>
  );
}

function FirstRun() {
  return (
    <section className="gym-first">
      <p className="gym-first-line">
        Build your routine here — your phone starts the workout from it. Or just start logging on
        the phone, and name what you did at the end.
      </p>
      <a className="gym-first-write" href={routineHref(NEW_ROUTINE_ID)}>Build a routine</a>
    </section>
  );
}

function TrainingNow({ session, sets, catalog, restSeconds }) {
  const [, setBeat] = useState(0);
  useEffect(() => {
    const beat = setInterval(() => setBeat((count) => count + 1), BEAT_MS);
    return () => clearInterval(beat);
  }, []);

  const now = Date.now();
  const routine = routineNameOf(session);
  const newest = sets.length === 0
    ? null
    : sets.reduce((late, set) => (set.completedAt >= late.completedAt ? set : late));
  const walked = newest === null
    ? []
    : sets.filter((set) => set.exerciseId === newest.exerciseId)
      .sort((left, right) => (left.setNumber ?? 0) - (right.setNumber ?? 0));

  return (
    <section className="gym-mirror">
      <p className="gym-mirror-head">
        <span className="gym-live-dot" aria-hidden="true" />
        {`Training now${routine ? ` · ${routine}` : ''}  ·  ${clockOf(now - session.startedAt)}`}
      </p>
      {newest && (
        <>
          <p className="gym-mirror-line">
            <a className="gym-movement-door" href={recordHref(newest.exerciseId)}>
              {nameOfMovement(catalog, newest.exerciseId)}
            </a>
            {` — set ${newest.setNumber}`
              + `  ·  ${fmt(newest.weightKg)} × ${newest.reps}`
              + `  ·  last set ${clockOf(now - newest.completedAt)} ago`
              + (restSeconds == null ? '' : `  ·  rest ${restLabel(restSeconds)}`)}
          </p>
          <p className="gym-mirror-sets">
            {walked
              .map((set) => `${fmt(set.weightKg)} × ${set.reps}${set.kind !== 'working' ? ` (${set.kind})` : ''}`)
              .join('   ·   ')}
          </p>
        </>
      )}
    </section>
  );
}
