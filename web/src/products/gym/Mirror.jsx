import React, { useEffect, useState } from 'react';
import { Clock3, Timer } from 'lucide-react';
import {
  clockOf, fmt, nameOfMovement, planReadingOf, recordHref, routineNameOf, slotRows, workoutClocks,
} from './log.js';
import { LogNotOpen } from './Log.jsx';

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
    />
  );
}

const BEAT_MS = 500;

// The beat is this component's own state, so the list under it does not re-render on it.
function TrainingNow({ session, sets, catalog }) {
  const [, setBeat] = useState(0);
  useEffect(() => {
    const beat = setInterval(() => setBeat((count) => count + 1), BEAT_MS);
    return () => clearInterval(beat);
  }, []);

  const clocks = workoutClocks(session, sets, Date.now());
  const routine = routineNameOf(session);
  const newest = sets.length === 0
    ? null
    : sets.reduce((late, set) => (set.completedAt >= late.completedAt ? set : late));
  const walked = newest === null
    ? []
    : sets.filter((set) => set.exerciseId === newest.exerciseId)
      .sort((left, right) => (left.setNumber ?? 0) - (right.setNumber ?? 0));
  // The plan's own slots for the movement in hand: the landed sets fill them in order and the rest
  // stand under them as targets, dim. The mirror starts nothing and changes nothing (R11).
  const reading = newest === null ? null : planReadingOf(session, newest.exerciseId);
  const rows = newest === null ? [] : slotRows(walked, reading.entry);

  return (
    <section className="gym-mirror">
      <p className="gym-mirror-head">
        <span className="gym-live-dot" aria-hidden="true" />
        {`Training now${routine ? ` · ${routine}` : ''}`}
      </p>
      {newest && (
        <>
          <p className="gym-mirror-line">
            <a className="gym-movement-door" href={recordHref(newest.exerciseId)}>
              {nameOfMovement(catalog, newest.exerciseId)}
            </a>
            {` — set ${newest.setNumber}`
              + `  ·  ${fmt(newest.weightKg)} × ${newest.reps}`}
          </p>
        </>
      )}
      <div className="gym-workout-clocks" aria-live="off">
        {clocks.map((clock, index) => <span className="gym-workout-clock" key={clock.label}
          role="group" tabIndex={0} aria-label={`${clock.label}: ${clock.spoken}`}>
          {index === 0 ? <Clock3 size={16} aria-hidden="true" /> : <Timer size={16} aria-hidden="true" />}
          <span aria-hidden="true">{clockOf(clock.elapsed)}</span>
        </span>)}
      </div>
      {newest && (<>
          {reading.kind === 'planned' && <p className="gym-mirror-plan">{reading.line}</p>}
          <ul className="gym-mirror-slots">
            {rows.map((row) => (
              <li className={`gym-mirror-slot is-${row.kind}`} key={row.key} aria-label={row.spoken}>
                {row.label}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
