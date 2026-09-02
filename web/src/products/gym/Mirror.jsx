import React, { useEffect, useState } from 'react';
import { clockOf, fmt, FROM_THE_ROUTINE, nameOfMovement, recordHref, restInForce, routineNameOf } from './log.js';
import { LogNotOpen } from './Log.jsx';
import { restLabel } from './settings/preferences.js';

// The mirror's charter (ledger 0t): it never offers a Finish, it says "Not training now." in words
// rather than as a greyed control, and every clock on it counts up. Nothing here can drive the
// workout it shows.
export function LiveMirror({ log, onSignIn }) {
  if (log.phase === 'loading') return null;
  if (log.phase === 'failed') return <LogNotOpen log={log} onSignIn={onSignIn} />;
  if (!log.session) {
    return (
      <section className="gym-mirror-idle">
        <p className="gym-mirror-idle-line">Not training now.</p>
        <p className="gym-quiet">Workouts start on your phone.</p>
      </section>
    );
  }
  return (
    <TrainingNow
      session={log.session}
      sets={log.sets}
      catalog={log.catalog}
      restSeconds={log.preferences.restSeconds}
    />
  );
}

const BEAT_MS = 500;

// The beat is this component's own state, so the list under it does not re-render on it.
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
  const rest = newest === null ? null : restInForce(session, newest.exerciseId, restSeconds);
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
              + (rest === null ? '' : `  ·  target ${restLabel(rest.seconds)}${rest.fromRoutine ? FROM_THE_ROUTINE : ''}`)}
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
