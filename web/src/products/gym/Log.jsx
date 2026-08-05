// THE LOG — every session that happened, newest first, and one of them read whole. G8 draws the row
// as the web's home: the day and the routine on one line, what the session was on the next, the top
// set in its own column, and one ghost door beside the title for the workout that never made it in.
//
// THE ROW DRAWS THE TOP SET AND THE AUTO-CLOSE NOTE FROM THE STORE'S OWN ANSWER. The session LIST
// carries no sets, so neither could be read here at all until the summary began carrying `topSet`
// and `closedItself` beside the set count (gymApi.js); a session read whole still derives both from
// the sets it has in hand, by the same rules, in the same two functions (log.js). Deriving either
// from a set COUNT would have been a number nobody lifted.
//
// The door is refused in place while a session is open, on a neutral surface with the live dot and
// never in alarm ink, because nothing failed: the workout is simply still running (backfill.js).

import React, { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { gymApi } from './gymApi.js';
import { MID_WORKOUT_REFUSAL } from './backfill.js';
import {
  BACKFILL_HREF, CLOSED_ITSELF_NOTE, closedOnItsOwn, dayLabel, fmt, groupByExercise, NO_ROUTINE,
  routineNameOf, sessionHref, sessionMetaLabel, timeLabel, topSetLabel, topSetOf,
} from './log.js';
import { useGymRead } from './useGymRead.js';

export function LogList({ live }) {
  const { phase, summaries, older, session } = live;
  const [refused, setRefused] = useState(false);

  return (
    <>
      <header className="gym-head gym-log-head">
        <h1 className="gym-title">The log</h1>
        <button
          type="button"
          className="gym-door-past"
          onClick={() => { if (session) setRefused(true); else window.location.hash = BACKFILL_HREF; }}
        >
          Add a past workout
        </button>
      </header>
      {refused && (
        <section className="gym-refusal">
          <p className="gym-refusal-title">
            <span className="gym-live-dot" aria-hidden="true" />
            {MID_WORKOUT_REFUSAL.title}
          </p>
          <p className="gym-refusal-body">{MID_WORKOUT_REFUSAL.body}</p>
          <button type="button" className="gym-refusal-close" onClick={() => setRefused(false)}>Close</button>
        </section>
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
        <>
          <ul className="gym-sessions">
            {summaries.map((summary) => <SessionRow key={summary.id} summary={summary} />)}
          </ul>
          {/* The rows stay when the read failed — they are real sessions and worth reading. The foot
              does not: a screen already admitting it could not load has not earned the right to also
              say the log ends here, least of all to someone checking whether an import came across. */}
          {phase !== 'failed' && <OlderSessions older={older} />}
        </>
      )}
    </>
  );
}

// The foot of the log. One page deeper per press, in words rather than a spinner — everything else
// in gym says it is waiting by saying so. The bottom is stated out loud because it is a real answer:
// a lifter who has just imported years of training is reading this list to find out whether all of
// it came across.
function OlderSessions({ older }) {
  if (older.status === 'end') return <p className="gym-log-bottom">That’s the start of your log.</p>;
  if (older.status === 'failed') {
    return (
      <p className="gym-read-failed gym-older-failed">
        The older sessions didn’t load.
        <button type="button" className="gym-retry" onClick={older.load}>Try again</button>
      </p>
    );
  }
  return (
    // aria-disabled rather than disabled: a real `disabled` drops focus to the body on every press,
    // so a keyboard reader walking a long log loses their place once per page and tabs back down
    // past everything they just loaded. What actually makes a second press safe is loadOlder's own
    // early return, never the attribute.
    <button
      type="button"
      className="gym-older"
      onClick={older.load}
      aria-disabled={older.status === 'loading'}
      aria-busy={older.status === 'loading'}
    >
      {older.status === 'loading' ? 'Loading older sessions…' : 'Load older sessions'}
    </button>
  );
}

// The day leads and the routine sits beside it, because a lifter looking for a session knows when it
// was before they know what it was. A session with no routine reads one step quieter and never as a
// fault: most rows in most logs will not have one. The length and the count are the meta line's and
// are not repeated up here — one fact, one place, which is the same rule that keeps the day out of
// `sessionMetaLabel`.
function SessionRow({ summary }) {
  const routine = routineNameOf(summary);
  const exercises = summary.exercises ?? [];
  const top = topSetOf(summary);
  return (
    <li>
      <a className="gym-row" href={sessionHref(summary.id)}>
        <div className="gym-row-body">
          <div className="gym-row-top">
            <span className="gym-row-day">{dayLabel(summary.startedAt)}</span>
            <span className={routine ? 'gym-row-title' : 'gym-row-title is-adhoc'}>{routine ?? NO_ROUTINE}</span>
          </div>
          <div className="gym-row-meta">{sessionMetaLabel(summary, summary.setCount ?? 0)}</div>
          {exercises.length > 0 && <div className="gym-row-movements">{exercises.join('   ·   ')}</div>}
          {/* Said once by the band at the moment it happens; this is the permanent record (G8). */}
          {closedOnItsOwn(summary) && <div className="gym-row-closed">{CLOSED_ITSELF_NOTE}</div>}
        </div>
        {/* A session holding no working set has no top set, and the column is absent rather than
            dashed: a row is not a table, and nothing is missing from it. */}
        {top && (
          <div className="gym-row-top-set">
            <span className="gym-row-top-value">{topSetLabel(top)}</span>
            <span className="gym-row-top-label">top set</span>
          </div>
        )}
      </a>
    </li>
  );
}

export function SessionDetail({ id }) {
  const view = useGymRead(
    () => Promise.all([gymApi.session(id), gymApi.exercises()])
      .then(([detail, catalog]) => (detail ? { detail, catalog } : null)),
    [id],
  );

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
          <button type="button" className="gym-retry" onClick={view.retry}>Retry</button>
        </p>
      </>
    );
  }

  const { session, sets } = view.data.detail;
  const names = new Map(view.data.catalog.map((exercise) => [exercise.id, exercise.name]));
  const routine = routineNameOf(session);
  const top = topSetOf(session, sets);
  return (
    <>
      <header className="gym-detail-head">
        <a className="gym-back" href="#/gym/log"><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Log</a>
        <h1 className="gym-title">
          {dayLabel(session.startedAt)}
          <span className="gym-detail-routine">{`  ·  ${routine ?? NO_ROUTINE}`}</span>
        </h1>
        <p className="gym-detail-when">{sessionMetaLabel(session, sets.length)}</p>
        {top && <p className="gym-detail-top">{`top set  ·  ${topSetLabel(top)}`}</p>}
        {closedOnItsOwn(session, sets) && <p className="gym-detail-closed">{CLOSED_ITSELF_NOTE}</p>}
      </header>
      {sets.length === 0 && <p className="gym-quiet">No sets in this session.</p>}
      {groupByExercise(sets).map(([exerciseId, group]) => (
        <section className="gym-exercise" key={exerciseId}>
          <h2 className="gym-exercise-name">{names.get(exerciseId) ?? exerciseId}</h2>
          <ul className="gym-sets">
            {group.map((set) => (
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
