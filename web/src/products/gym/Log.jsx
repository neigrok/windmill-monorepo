import React, { useState } from 'react';
import { Button } from '../../design-system/index.js';
import { Back } from './Back.jsx';
import { gymApi } from './gymApi.js';
import { MID_WORKOUT_REFUSAL } from './backfill.js';
import { BodyweightReading, useBodyweight, WeighInChip, WeighInSheet } from './bodyweight/Bodyweight.jsx';
import { deletedLine, deleteFailure, fixFailure, setsAfter } from './fix.js';
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
        <Button variant="secondary" size="sm" onClick={onSignIn}>Sign in</Button>
      </p>
    );
  }
  return (
    <p className="gym-read-failed">
      {log.failure === 'signal' ? 'The log didn’t load. Open it again when you have signal.' : 'The log didn’t answer.'}
      <Button variant="secondary" size="sm" onClick={log.retryBoot}>Retry</Button>
    </p>
  );
}

export function LogList({ log, onSignIn }) {
  const { phase, summaries, older, session } = log;
  const [refused, setRefused] = useState(false);
  // A session withheld for deletion is off the log for the length of its window — the transient is
  // the only place it still exists, and the only way back — and off it for good once the store has
  // answered for it.
  const discarded = log.hidden('session');
  const shown = summaries.filter((summary) => !discarded.has(summary.id));
  const weeks = weeksOf(shown, { complete: older.status === 'end' });
  // The reading at the head and the chip in the reach band are the two halves of one number.
  const weights = useBodyweight();
  const [weighing, setWeighing] = useState(false);

  return (
    <>
      <header className="gym-head gym-log-head">
        <div>
          <h1 className="gym-title">The log</h1>
          {shown.length > 0 && (
            <p className="gym-log-count">{loadedLine(shown.length, weeks.length)}</p>
          )}
          <BodyweightReading latest={weights.latest} />
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
      {phase !== 'loading' && phase !== 'failed' && shown.length === 0 && (
        <>
          <p className="gym-quiet">No sessions yet.</p>
          <p className="gym-quiet">The first one you log lands here, newest first.</p>
        </>
      )}
      {shown.length > 0 && (
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
          {phase !== 'failed' && <LogFoot older={older} oldest={shown[shown.length - 1]} />}
        </>
      )}
      <div className="gym-reach-spacer" aria-hidden="true" />
      <WeighInChip onOpen={() => setWeighing(true)} />
      {weighing && (
        <WeighInSheet
          onSave={async (write) => {
            const refused = await weights.save(write);
            if (!refused) setWeighing(false);
            return refused;
          }}
          onClose={() => setWeighing(false)}
        />
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
  const { say, reloadLog, withhold } = log;
  const view = useGymRead(
    () => Promise.all([gymApi.session(id), gymApi.exercises()])
      .then(([detail, catalog]) => (detail ? { detail, catalog } : null)),
    [id],
  );
  // moves: set id → the store's row, for a set this screen corrected in place. A set DELETED is not
  // here in any form: whether it is still withheld or already spent, the room is what knows, and the
  // room outlives this screen.
  const [moves, setMoves] = useState(() => new Map());
  const [fixing, setFixing] = useState(null);

  // Withheld: nothing is on the wire until the window closes, and leaving this screen does not close
  // it. The transient the room draws is the only Undo there is.
  const dropSet = (set) => {
    setFixing(null);
    withhold({
      kind: 'set',
      id: set.id,
      line: deletedLine(set),
      send: async () => {
        await gymApi.deleteSet(id, set.id);
        await reloadLog();
      },
      refused: (error) => say(deleteFailure(error)),
    });
  };

  // A re-read drops the corrections in hand; the deletes it must not drop are the room's, and a
  // re-read cannot reach them.
  const reread = () => {
    setMoves(new Map());
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
          <Button variant="secondary" size="sm" onClick={reread}>Retry</Button>
        </p>
      </>
    );
  }

  const { session } = view.data.detail;
  // Fold the moves in, then take out what the window is holding, before anything is derived off the
  // sets: a withheld delete is as gone from this screen as a settled one, and comes back on Undo.
  const goneSets = log.hidden('set');
  const sets = setsAfter(view.data.detail.sets, moves).filter((set) => !goneSets.has(set.id));
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
          onDelete={() => dropSet(fixing)}
          onClose={() => setFixing(null)}
        />
      )}
    </>
  );
}
