import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Back } from './Back.jsx';
import { gymApi } from './gymApi.js';
import { MID_WORKOUT_REFUSAL } from './backfill.js';
import { deletedLine, deleteFailure, fixFailure, movesAfterRead, setsAfter, UNDO_MS } from './fix.js';
import { FixSheet } from './FixSheet.jsx';
import {
  BACKFILL_HREF, CLOSED_ITSELF_NOTE, closedOnItsOwn, e1rmLabel, finishHref, firstSessionLabel,
  groupByExercise, hasRecord, isFinished, loadedLine, logWhenLabel, NO_ROUTINE, onThisDevice,
  planFrozenLabel, planReadingOf, recordHref, routineNameOf, sessionDetailMeta, sessionHref,
  setLoadLabel, setNoteOf, tonnageLabel, weeksOf, workingLabel,
} from './log.js';
import { ShareWorkout } from './share/ShareWorkout.jsx';
import { useGymRead } from './useGymRead.js';

export function LogNotOpen({ log, onSignIn }) {
  if (log.failure === 'signed-out') {
    return (
      <p className="gym-read-failed">
        Your sign-in lapsed.
        <button type="button" className="gym-retry" onClick={onSignIn}>Sign in</button>
      </p>
    );
  }
  return (
    <p className="gym-read-failed">
      {log.failure === 'signal' ? 'The log didn’t load. Open it again when you have signal.' : 'The log didn’t answer.'}
      <button type="button" className="gym-retry" onClick={log.retryBoot}>Retry</button>
    </p>
  );
}

export function LogList({ log, onSignIn }) {
  const { phase, summaries, older, session } = log;
  const [refused, setRefused] = useState(false);
  const weeks = weeksOf(summaries, { complete: older.status === 'end' });

  return (
    <>
      <header className="gym-head gym-log-head">
        <div>
          <h1 className="gym-title">The log</h1>
          {summaries.length > 0 && (
            <p className="gym-log-count">{loadedLine(summaries.length, weeks.length)}</p>
          )}
        </div>
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
      {phase === 'failed' && <LogNotOpen log={log} onSignIn={onSignIn} />}
      {phase !== 'loading' && phase !== 'failed' && summaries.length === 0 && (
        <>
          <p className="gym-quiet">No sessions yet.</p>
          <p className="gym-quiet">The first one you log lands here, newest first.</p>
        </>
      )}
      {summaries.length > 0 && (
        <>
          {weeks.map((week) => (
            <section className="gym-week" key={week.startedAt}>
              <div className="gym-week-head">
                <span className="gym-week-label">{week.label}</span>
                <span className="gym-week-rule" aria-hidden="true" />
                {week.tonnage && <span className="gym-week-tonnage">{week.tonnage}</span>}
              </div>
              <ul className="gym-sessions">
                {week.sessions.map((summary) => <SessionRow key={summary.id} summary={summary} />)}
              </ul>
            </section>
          ))}
          {phase !== 'failed' && <LogFoot older={older} oldest={summaries[summaries.length - 1]} />}
        </>
      )}
    </>
  );
}

function LogFoot({ older, oldest }) {
  if (older.status === 'end') return <p className="gym-log-bottom">{firstSessionLabel(oldest.startedAt)}</p>;
  if (older.status === 'failed') {
    return (
      <button type="button" className="gym-log-failed" onClick={older.load}>That read failed · retry</button>
    );
  }
  return (
    // aria-disabled, not disabled: disabled drops focus. loadOlder's early return makes a second press safe.
    <button
      type="button"
      className="gym-older"
      onClick={older.load}
      aria-disabled={older.status === 'loading'}
      aria-busy={older.status === 'loading'}
    >
      {older.status === 'loading' ? <><span className="gym-older-dot" aria-hidden="true" />Loading</> : 'Load older'}
    </button>
  );
}

function SessionRow({ summary }) {
  const facts = [
    typeof summary.workingSetCount === 'number' ? workingLabel(summary.workingSetCount) : null,
    tonnageLabel(summary.tonnageKg),
    e1rmLabel(summary.topE1rm),
  ].filter(Boolean);
  return (
    <li>
      <a className="gym-row" href={sessionHref(summary.id)}>
        <div className="gym-row-head">
          <span className="gym-row-title">{routineNameOf(summary) ?? NO_ROUTINE}</span>
          {hasRecord(summary) && <span className="gym-row-pr" title="a personal record happened here" />}
          {onThisDevice(summary) && <span className="gym-row-ring" title="saved on this device only" />}
          <span className="gym-row-when">{logWhenLabel(summary)}</span>
        </div>
        {facts.length > 0 && (
          <div className="gym-row-facts">
            {facts.map((fact) => <span key={fact}>{fact}</span>)}
          </div>
        )}
        {closedOnItsOwn(summary) && <div className="gym-row-closed">{CLOSED_ITSELF_NOTE}</div>}
      </a>
    </li>
  );
}

export function SessionDetail({ id, log }) {
  // Destructured: depending on the whole `log` literal would re-fire the withheld delete's cleanup every render.
  const { say, reloadLog } = log;
  const view = useGymRead(
    () => Promise.all([gymApi.session(id), gymApi.exercises()])
      .then(([detail, catalog]) => (detail ? { detail, catalog } : null)),
    [id],
  );
  // moves: set id → the store's row, or null for a deleted set.
  const [moves, setMoves] = useState(() => new Map());
  const [fixing, setFixing] = useState(null);

  // Deletes are withheld UNDO_MS before sending; a list, since several can be armed at once.
  const withheld = useRef([]);

  const settle = useCallback((setId) => {
    const held = withheld.current.find((each) => each.set.id === setId);
    if (held) clearTimeout(held.timer);
    withheld.current = withheld.current.filter((each) => each.set.id !== setId);
    return held?.set ?? null;
  }, []);

  const sendDelete = useCallback(async (setId) => {
    const set = settle(setId);
    if (!set) return;
    try {
      await gymApi.deleteSet(id, setId);
    } catch (error) {
      setMoves((current) => new Map(current).set(setId, set));
      say(deleteFailure(error));
      return;
    }
    reloadLog();
  }, [id, settle, say, reloadLog]);

  // Unmount sends every still-withheld delete; a closed tab sends none and the set stands.
  useEffect(() => () => {
    withheld.current.forEach((held) => {
      sendDelete(held.set.id);
      say(deletedLine(held.set));
    });
  }, [sendDelete, say]);

  const withholdDelete = (set) => {
    setFixing(null);
    setMoves((current) => new Map(current).set(set.id, null));
    withheld.current = [...withheld.current, { set, timer: setTimeout(() => sendDelete(set.id), UNDO_MS) }];
    say(deletedLine(set), { label: 'Undo', run: () => { if (settle(set.id)) setMoves((current) => new Map(current).set(set.id, set)); } });
  };

  // A re-read drops the corrections in hand; the withheld deletes stay, nothing was sent for them.
  const reread = () => {
    setMoves(movesAfterRead);
    view.retry();
  };

  const saveFix = async (set, fix) => {
    setFixing(null);
    if (Object.keys(fix).length === 0) return;
    try {
      const stored = await gymApi.fixSet(id, set.id, fix);
      setMoves((current) => new Map(current).set(set.id, stored));
    } catch (error) {
      say(fixFailure(error));
      if (error.setNotFound) reread();
      return;
    }
    reloadLog();
  };

  if (view.phase === 'loading') return <p className="gym-quiet">Opening the session…</p>;
  if (view.phase === 'absent') {
    return (
      <>
        <Back href="#/gym/log">The log</Back>
        <p className="gym-quiet">This session isn’t in your log.</p>
      </>
    );
  }
  if (view.phase === 'failed') {
    return (
      <>
        <Back href="#/gym/log">The log</Back>
        <p className="gym-read-failed">
          The session didn’t load.
          <button type="button" className="gym-retry" onClick={reread}>Retry</button>
        </p>
      </>
    );
  }

  const { session } = view.data.detail;
  // Fold the moves in before anything is derived off the sets.
  const sets = setsAfter(view.data.detail.sets, moves);
  const names = new Map(view.data.catalog.map((exercise) => [exercise.id, exercise.name]));
  const frozen = planFrozenLabel(session);
  return (
    <>
      <header className="gym-detail-head">
        <Back href="#/gym/log">The log</Back>
        <h1 className="gym-title">{routineNameOf(session) ?? NO_ROUTINE}</h1>
        <p className="gym-detail-when">{sessionDetailMeta(session, sets)}</p>
        {frozen && (
          <p className="gym-detail-plan">
            <span className="gym-detail-plan-dot" aria-hidden="true" />
            {frozen}
          </p>
        )}
        {closedOnItsOwn(session, sets) && <p className="gym-detail-closed">{CLOSED_ITSELF_NOTE}</p>}
        {isFinished(session) && <a className="gym-detail-review" href={finishHref(session.id)}>Session review ›</a>}
      </header>
      {sets.length === 0 && <p className="gym-quiet">No sets in this session.</p>}
      {groupByExercise(sets).map(([exerciseId, group]) => {
        const reading = planReadingOf(session, exerciseId);
        // The note lands on the first WORKING set; a warmup never carries it.
        const opener = group.find((set) => set.kind === 'working');
        return (
          <section className="gym-exercise" key={exerciseId}>
            <div className="gym-exercise-head">
              <h2 className="gym-exercise-name">
                <a className="gym-movement-door" href={recordHref(exerciseId)}>{names.get(exerciseId) ?? exerciseId}</a>
              </h2>
              {reading.line && (
                <span className={reading.entry ? 'gym-exercise-plan' : 'gym-exercise-plan is-added'}>
                  {reading.line}
                </span>
              )}
            </div>
            <ul className="gym-sets">
              {group.map((set) => {
                const note = setNoteOf(set, reading, set === opener);
                return (
                  <li key={set.id}>
                    <button
                      type="button"
                      className={['gym-set', set.kind === 'warmup' && 'gym-set-warmup', fixing?.id === set.id && 'is-fixing'].filter(Boolean).join(' ')}
                      onClick={() => setFixing(set)}
                    >
                      <span className="gym-set-mark" aria-hidden="true">{set.kind === 'warmup' ? '·' : '✓'}</span>
                      <span className="gym-set-load">{setLoadLabel(set)}</span>
                      {set.rpe != null && <span className="gym-set-rpe">rpe {set.rpe}</span>}
                      <span className="gym-set-tail">
                        {note && <span className="gym-set-plan">{note}</span>}
                        <span className="gym-set-fix">tap to fix</span>
                      </span>
                      {set.note && <span className="gym-set-note">{set.note}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <ShareWorkout sessionId={id} />
      {fixing && (
        <FixSheet
          key={fixing.id}
          set={fixing}
          movement={names.get(fixing.exerciseId) ?? fixing.exerciseId}
          session={session}
          onSave={(fix) => saveFix(fixing, fix)}
          onDelete={() => withholdDelete(fixing)}
          onClose={() => setFixing(null)}
        />
      )}
    </>
  );
}
