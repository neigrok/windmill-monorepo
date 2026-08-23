import React from 'react';
import { gymApi } from '../gymApi.js';
import {
  CLOSED_ITSELF_NOTE, closedOnItsOwn, dayLabel, fmt, NO_ROUTINE, sessionMetaLabel, timeLabel,
  topSetLabel, topSetOf,
} from '../log.js';
import { KG, spellWeightsIn } from '../units.js';
import { useGymRead } from '../useGymRead.js';
import { SHARED_ABSENT, SHARED_TERMS, sharedGroups } from './share.js';

export function SharedSession({ token }) {
  // Set in the render, not an effect: `fmt` reads the spelling while the numbers below are built.
  spellWeightsIn(KG);
  const view = useGymRead(() => gymApi.sharedSession(token), [token]);

  if (view.phase === 'loading') return <main className="gym-column"><p className="gym-quiet">Opening the workout…</p></main>;

  if (view.phase === 'absent') {
    return (
      <main className="gym-column gym-shared">
        <h1 className="gym-title">{SHARED_ABSENT.title}</h1>
        <p className="gym-quiet gym-shared-absent">{SHARED_ABSENT.body}</p>
      </main>
    );
  }

  if (view.phase === 'failed') {
    return (
      <main className="gym-column gym-shared">
        <p className="gym-read-failed">
          This didn’t load.
          <button type="button" className="gym-retry" onClick={view.retry}>Retry</button>
        </p>
      </main>
    );
  }

  const shared = view.data;
  const sets = shared.sets ?? [];
  const top = topSetOf(shared, sets);
  return (
    <main className="gym-column gym-shared">
      <p className="gym-shared-kicker">A shared workout</p>
      <header className="gym-detail-head">
        <h1 className="gym-title">
          {dayLabel(shared.startedAt)}
          <span className="gym-detail-routine">{`  ·  ${shared.routine ?? NO_ROUTINE}`}</span>
        </h1>
        <p className="gym-detail-when">{sessionMetaLabel(shared, sets.length)}</p>
        {top && <p className="gym-detail-top">{`top set  ·  ${topSetLabel(top)}`}</p>}
        {closedOnItsOwn(shared, sets) && <p className="gym-detail-closed">{CLOSED_ITSELF_NOTE}</p>}
      </header>

      {sets.length === 0 && <p className="gym-quiet">No sets in this session.</p>}
      {sharedGroups(sets).map(([exercise, group]) => (
        <section className="gym-exercise" key={exercise}>
          <h2 className="gym-exercise-name">{exercise}</h2>
          <ul className="gym-sets">
            {/* No set on this wire has an id, so the row is keyed by place plus set number. */}
            {group.map((set, index) => (
              <li key={`${set.setNumber}-${index}`} className={set.kind === 'warmup' ? 'gym-set gym-set-warmup' : 'gym-set'}>
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

      <footer className="gym-shared-foot">
        {SHARED_TERMS.map((term) => <p key={term}>{term}</p>)}
      </footer>
    </main>
  );
}
