// TODAY — the one question this room answers: what am I doing right now. It is the home of the
// product and the only surface that ever asks for anything, because gym sends no notifications.
//
// Two ways in, always, and which pair is offered depends only on whether a routine exists yet. With
// routines: the one that has waited longest, its first movements, and Start — with `Log without a
// routine` under it, because a program is a plan and not a cage. With none: canon screen 1 exactly,
// which is a start button and a way to write a routine down — no tour, no sample program, no
// questions about goals or experience. This lifter already has a program; the app's job is to catch
// it, not to write it.
//
// Nothing on this screen claims a workout is DUE today. Gym keeps no calendar and the card names no
// date: what it says is when that routine was last trained, which is the fact the wire carries and
// the fact a lifter decides on (routines.js).

import React from 'react';
import { gymApi } from './gymApi.js';
import {
  dayLabel, durLabel, entryLabel, isFinished, nameOfMovement, NEW_ROUTINE_ID, NO_ROUTINE,
  routineHref, routineMetaLabel, routineNameOf, sessionHref, setCountLabel,
} from './log.js';
import { dueRoutine } from './routines.js';
import { useGymRead } from './useGymRead.js';

const PREVIEW_ENTRIES = 3;

export function Today({ live }) {
  const view = useGymRead(() => gymApi.routines(), []);

  if (live.phase === 'loading') return <p className="gym-quiet">Opening the log…</p>;
  if (live.phase === 'failed') return <p className="gym-read-failed">The log didn’t load. Open it again when you have signal.</p>;

  // A routines read that did not come back is not a reason to hide the way into a session: an
  // ad-hoc start needs nothing from it, and a lifter standing at a rack is not here to retry a read.
  const routines = view.phase === 'ready' ? view.data : [];
  const due = dueRoutine(routines);
  const last = live.summaries.find(isFinished) ?? null;

  return (
    <section className="gym-today-screen">
      <h1 className="gym-title">Today</h1>
      <p className="gym-quiet">
        {live.summaries.length === 0 ? 'nothing logged yet' : `${dayLabel(Date.now())} · nothing running`}
      </p>

      {due && (
        <>
          <article className="gym-due">
            <header className="gym-due-head">
              <a className="gym-due-name" href={routineHref(due.id)}>{due.name}</a>
              <span className="gym-due-when">{routineMetaLabel(due)}</span>
            </header>
            {/* Keyed on the POSITION as well as the movement, because a routine may legitimately
                name one lift twice — the heavy line and the back-off line — and two rows sharing a
                key is a list React reconciles however it likes. The editor's own list agrees. */}
            <ul className="gym-due-entries">
              {due.entries.slice(0, PREVIEW_ENTRIES).map((entry, index) => (
                <li key={`${entry.exerciseId}-${index}`} className="gym-due-entry">
                  <span>{nameOfMovement(live.catalog, entry.exerciseId)}</span>
                  <span className="gym-due-target">{entryLabel(entry)}</span>
                </li>
              ))}
              {due.entries.length > PREVIEW_ENTRIES && (
                <li className="gym-due-more">{`+ ${due.entries.length - PREVIEW_ENTRIES} more`}</li>
              )}
            </ul>
            <button type="button" className="gym-start" onClick={() => live.start({ routineId: due.id })}>
              {`Start ${due.name}`}
            </button>
          </article>
          <button type="button" className="gym-start-adhoc" onClick={() => live.start()}>Log without a routine</button>
        </>
      )}

      {/* Canon screen 1, and it is only drawn once the store has SAID there are no routines. A read
          still in flight gets the start button on its own, and a read that failed says so: telling a
          lifter with six routines that today is where their first one comes from would be the app
          inventing a fact out of its own silence. */}
      {!due && view.phase === 'ready' && (
        <>
          <p className="gym-today-line">
            Start empty and pick movements as you go. What you do today becomes your routine — you
            name it at the end.
          </p>
          <button type="button" className="gym-start" onClick={() => live.start()}>Start a session</button>
          <a className="gym-start-adhoc" href={routineHref(NEW_ROUTINE_ID)}>Type out a routine first</a>
        </>
      )}
      {!due && view.phase !== 'ready' && (
        <>
          <button type="button" className="gym-start" onClick={() => live.start()}>Start a session</button>
          {view.phase === 'failed' && (
            <p className="gym-read-failed">
              Your routines didn’t load.
              <button type="button" className="gym-retry" onClick={view.retry}>Retry</button>
            </p>
          )}
        </>
      )}

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
    </section>
  );
}
