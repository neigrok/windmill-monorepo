// THE LOG — every session that happened, newest first, folded into weeks, and one of them read
// whole beside what the plan asked for. §G16 gives a row four facts a lifter scans: what it was and
// when, then the working sets, the tonnage and the top e1RM. §G17 draws the session itself with the
// plan dim and the actual bright.
//
// THAT LAST SENTENCE USED TO BE PRINTED UNDER THE SESSION (W9). "Dim is what the plan said. Bright
// is what you did." was the thesis of the screen, drawn on the screen — a caption explaining a
// contrast the eye reads in one glance. It is the argument for the design and it belongs beside the
// screen, in §G's notes and in this comment; the dim and the bright still say it, and they say it
// without being read.
//
// EVERY NUMBER ON A ROW COMES OFF THE WIRE. The session LIST carries no sets, so the working count
// and the tonnage are the store's own aggregations and the e1RM is the domain's own Epley over the
// top set it picked (gymApi.js) — nothing here derives one, and a row draws nothing where a
// deployment sent nothing. A session read WHOLE carries its sets, so the same facts are read off
// them by the same rules in the same functions (log.js): two sources, one rule, exactly as the top
// set and the auto-close note already had.
//
// The web is the mirror and the DESK (§11.2). No workout starts here and no set is logged here —
// but correcting last Tuesday is exactly what somebody sits down at a laptop to do, so this is the
// surface that has to be good at it: §G18's sheet opens on any set of a session read whole, and
// §G17's `tap to fix` is on those rows at last. The other write door is the backfill, refused in
// place while a session is open, on a neutral surface with the live dot and never in alarm ink,
// because nothing failed — the workout is simply still running (backfill.js).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
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
import { CoachShare } from './share/CoachShare.jsx';
import { useGymRead } from './useGymRead.js';

export function LogList({ log }) {
  const { phase, summaries, older, session } = log;
  const [refused, setRefused] = useState(false);
  // The fold is over the page in hand, and it is told whether that page is the whole log: the
  // oldest week's tonnage is a floor until nothing more can be added to it (log.js).
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
      {phase === 'failed' && <p className="gym-read-failed">The log didn’t load. Open it again when you have signal.</p>}
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
          {/* The rows stay when the read failed — they are real sessions and worth reading. The foot
              does not: a screen already admitting it could not load has not earned the right to also
              say the log ends here, least of all to someone checking whether an import came across. */}
          {phase !== 'failed' && <LogFoot older={older} oldest={summaries[summaries.length - 1]} />}
        </>
      )}
    </>
  );
}

// THE FOOT OF THE LOG, in the order a scroll meets its four states (§G16). One page deeper per
// press — a tap and not a scroll, so the request is the lifter's. Loading is the same box dimmed,
// with no spinner and no skeleton rows pretending to be sessions. The bottom is a DATE, because a
// lifter who has just imported years of training is reading this list to find out whether all of it
// came across, and the day they started is the one fact worth arriving at. A read that failed says
// so in alarm ink and offers the one move.
function LogFoot({ older, oldest }) {
  if (older.status === 'end') return <p className="gym-log-bottom">{firstSessionLabel(oldest.startedAt)}</p>;
  if (older.status === 'failed') {
    return (
      <button type="button" className="gym-log-failed" onClick={older.load}>That read failed · retry</button>
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
      {older.status === 'loading' ? <><span className="gym-older-dot" aria-hidden="true" />Loading</> : 'Load older'}
    </button>
  );
}

// The routine leads and when it happened sits opposite it, because a lifter scanning a log for a
// session is looking for what it was — the week divider above already answered roughly when. A
// session with no routine is named at full strength like any other (§G16): the phrase itself is
// what keeps it from reading as a fault, so nothing dims it. Underneath, the three numbers, and a
// row draws only the ones it was actually sent.
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
          {/* The space beside the title belongs to what a session IS rather than what it holds, and
              it holds two marks: a gold dot means a personal record happened in there (§G16), a
              hollow ring means the session is saved on this device only. Both are the store's
              answer and neither is derived here (log.js). */}
          {hasRecord(summary) && <span className="gym-row-pr" title="a personal record happened here" />}
          {onThisDevice(summary) && <span className="gym-row-ring" title="saved on this device only" />}
          <span className="gym-row-when">{logWhenLabel(summary)}</span>
        </div>
        {facts.length > 0 && (
          <div className="gym-row-facts">
            {facts.map((fact) => <span key={fact}>{fact}</span>)}
          </div>
        )}
        {/* Said once by the band at the moment it happens; this is the permanent record (G8). */}
        {closedOnItsOwn(summary) && <div className="gym-row-closed">{CLOSED_ITSELF_NOTE}</div>}
      </a>
    </li>
  );
}

export function SessionDetail({ id, log }) {
  // Both are stable for the life of this screen (useTrainingLog), which is what lets the withheld
  // delete below hang off a callback whose identity never changes. The whole `log` object is a
  // fresh literal every render, and depending on it would rebuild that callback — and fire its
  // cleanup, and the delete with it — on every keystroke anywhere in the room.
  const { say, reloadLog } = log;
  const view = useGymRead(
    () => Promise.all([gymApi.session(id), gymApi.exercises()])
      .then(([detail, catalog]) => (detail ? { detail, catalog } : null)),
    [id],
  );
  // WHAT THIS SCREEN HAS MOVED SINCE THE READ — one entry per set corrected or deleted, the store's
  // own answer in each (fix.js). The screen is scoped to one session by its key in the frame, so
  // this can never outlive the workout it is a set of.
  const [moves, setMoves] = useState(() => new Map());
  const [fixing, setFixing] = useState(null);

  // EVERY DELETE IS WITHHELD FOR FIVE SECONDS AND NOTHING IS DESTROYED INSIDE THEM. The row leaves
  // the screen, the toast offers Undo, and only when the window closes does the DELETE go over the
  // wire — so the take-back is exact. The alternative shape, deleting now and re-posting on Undo,
  // cannot be: a re-posted set is a NEW row, minted at max+1, and it would come back at the bottom
  // of its movement instead of where the lifter left it.
  //
  // A list, not one: a second set can be deleted while the first is still in its window, and each
  // owes the store its own write at its own moment.
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
      // The set is still in the log, so it goes back on the screen. If this ran on the way out the
      // row has nowhere to return to and the toast is the whole of what the lifter gets — which is
      // why it names the state that is true rather than the action that failed (fix.js).
      setMoves((current) => new Map(current).set(setId, set));
      say(deleteFailure(error));
      return;
    }
    // The log row's tonnage, its working count, its top e1RM and its gold dot are all readings of
    // the sets that stand, and one of them just left.
    reloadLog();
  }, [id, settle, say, reloadLog]);

  // Leaving the screen sends whatever is still withheld: the lifter asked for it and the window
  // merely ran out early. A tab closed inside the window sends nothing at all and the set is still
  // in the log — of the two ways this can end wrong, a set that survives is the one a lifter can
  // repair, and a set silently destroyed is the one nobody can.
  useEffect(() => () => { withheld.current.forEach((held) => sendDelete(held.set.id)); }, [sendDelete]);

  const withholdDelete = (set) => {
    setFixing(null);
    setMoves((current) => new Map(current).set(set.id, null));
    withheld.current = [...withheld.current, { set, timer: setTimeout(() => sendDelete(set.id), UNDO_MS) }];
    say(deletedLine(set), { label: 'Undo', run: () => { if (settle(set.id)) setMoves((current) => new Map(current).set(set.id, set)); } });
  };

  // THE SESSION, READ AGAIN — and the corrections in hand let go of in the same breath. A re-read is
  // asked for because the log moved underneath this screen, so the answer coming back is newer than
  // every correction this screen is holding, and painting one back over it would undo the repair the
  // re-read was for. The withheld deletes stay: nothing has been sent for them (fix.js).
  const reread = () => {
    setMoves(movesAfterRead);
    view.retry();
  };

  const saveFix = async (set, fix) => {
    setFixing(null);
    // `{}` is legal on the wire and answers the stored row unchanged — so a Save that moved nothing
    // is a round trip with nothing to carry, and the sheet closing IS the whole answer.
    if (Object.keys(fix).length === 0) return;
    try {
      const stored = await gymApi.fixSet(id, set.id, fix);
      setMoves((current) => new Map(current).set(set.id, stored));
    } catch (error) {
      say(fixFailure(error));
      // The log moved under this screen — another device deleted the set, or this is not the
      // workout it was. One row is not the repair for that; the session is read again.
      if (error.setNotFound) reread();
      return;
    }
    reloadLog();
  };

  if (view.phase === 'loading') return <p className="gym-quiet">Opening the session…</p>;
  if (view.phase === 'absent') {
    return (
      <>
        <a className="gym-back" href="#/gym/log"><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> The log</a>
        <p className="gym-quiet">This session isn’t in your log.</p>
      </>
    );
  }
  if (view.phase === 'failed') {
    return (
      <>
        <a className="gym-back" href="#/gym/log"><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> The log</a>
        <p className="gym-read-failed">
          The session didn’t load.
          <button type="button" className="gym-retry" onClick={reread}>Retry</button>
        </p>
      </>
    );
  }

  const { session } = view.data.detail;
  // The corrections in hand, folded into the read BEFORE anything is derived from it — so the
  // header's working count, the tonnage, the plan note beside each set and the order they group in
  // all move with a fix in the same render (fix.js).
  const sets = setsAfter(view.data.detail.sets, moves);
  const names = new Map(view.data.catalog.map((exercise) => [exercise.id, exercise.name]));
  const frozen = planFrozenLabel(session);
  return (
    <>
      <header className="gym-detail-head">
        <a className="gym-back" href="#/gym/log"><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> The log</a>
        <h1 className="gym-title">{routineNameOf(session) ?? NO_ROUTINE}</h1>
        <p className="gym-detail-when">{sessionDetailMeta(session, sets)}</p>
        {frozen && (
          <p className="gym-detail-plan">
            <span className="gym-detail-plan-dot" aria-hidden="true" />
            {frozen}
          </p>
        )}
        {closedOnItsOwn(session, sets) && <p className="gym-detail-closed">{CLOSED_ITSELF_NOTE}</p>}
        {/* The review — the store's own reading of the session (Finish.jsx) — used to be reachable
            only from the web finish, and the web no longer finishes anything: this door is what
            keeps that surface on the map. Only a closed session has one; an open one has no
            comparison to draw yet. */}
        {isFinished(session) && <a className="gym-detail-review" href={finishHref(session.id)}>Session review ›</a>}
      </header>
      {sets.length === 0 && <p className="gym-quiet">No sets in this session.</p>}
      {groupByExercise(sets).map(([exerciseId, group]) => {
        const reading = planReadingOf(session, exerciseId);
        // `added today` is said once, on the first WORKING set — not on the first set. A movement
        // warmed up before it was worked would otherwise spend the note on a slot that never
        // carries one (a set the plan never asked for says only its own kind, log.js), and the
        // movement would never say it was added at all.
        const opener = group.find((set) => set.kind === 'working');
        return (
          <section className="gym-exercise" key={exerciseId}>
            <div className="gym-exercise-head">
              {/* THE NAME IS A DOOR (§H). A movement's record is reached by tapping its name
                  wherever it appears, and a session is the likeliest place to want it: the line
                  under the thumb says what happened today, and the record says where it stands. */}
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
                    {/* EVERY SET IS A DOOR (§G17's `tap to fix`), and the whole row is it rather
                        than a control at the end: the thing being corrected is the line, and a
                        target the width of the row is one a thumb and a pointer both find. The
                        label is not hidden from a reader — it is the only text saying what
                        pressing this does. */}
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
      {/* The same door the finish screen carries, at the other end of a session's life: a workout
          worth sending to a coach is usually one somebody went back and looked at. It is offered on
          an open session too — a link to one person says nothing about how the session went.
          THE CHAT IS NOT HERE, and it never was a door onto one workout in the first place: §L makes
          Ask a room over the whole log, reached from Today's band and never while a workout is
          running. A composer under a session still being logged would be asking a model about a
          workout that is still changing. */}
      <CoachShare sessionId={id} />
      {/* KEYED BY THE SET IT IS OF, for the reason the routine editor is keyed by its routine: the
          sheet holds a draft, and a draft may not outlive the thing it is a draft of. */}
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
