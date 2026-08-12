// THE LOG — every session that happened, newest first, folded into weeks, and one of them read
// whole beside what the plan asked for. §G16 gives a row four facts a lifter scans: what it was and
// when, then the working sets, the tonnage and the top e1RM. §G17 draws the session itself with the
// plan dim and the actual bright.
//
// EVERY NUMBER ON A ROW COMES OFF THE WIRE. The session LIST carries no sets, so the working count
// and the tonnage are the store's own aggregations and the e1RM is the domain's own Epley over the
// top set it picked (gymApi.js) — nothing here derives one, and a row draws nothing where a
// deployment sent nothing. A session read WHOLE carries its sets, so the same facts are read off
// them by the same rules in the same functions (log.js): two sources, one rule, exactly as the top
// set and the auto-close note already had.
//
// The web is the mirror and the desk (§11.2). Nothing on this screen starts, resumes or logs
// anything; the one write door is the backfill, and it is refused in place while a session is open,
// on a neutral surface with the live dot and never in alarm ink, because nothing failed — the
// workout is simply still running (backfill.js).

import React, { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { gymApi } from './gymApi.js';
import { MID_WORKOUT_REFUSAL } from './backfill.js';
import {
  BACKFILL_HREF, CLOSED_ITSELF_NOTE, closedOnItsOwn, e1rmLabel, finishHref, firstSessionLabel,
  groupByExercise, hasRecord, isFinished, loadedLine, logWhenLabel, NO_ROUTINE, onThisDevice,
  planFrozenLabel, planReadingOf, recordHref, routineNameOf, sessionDetailMeta, sessionHref,
  setLoadLabel, setNoteOf, tonnageLabel, weeksOf, workingLabel,
} from './log.js';
import { CoachPanel } from './coach/CoachPanel.jsx';
import { CoachShare } from './share/CoachShare.jsx';
import { useGymRead } from './useGymRead.js';

// The thesis of §G17, said on the screen it is about rather than only in the canon.
const PLAN_BESIDE_ACTUAL = 'Dim is what the plan said. Bright is what you did. A miss gets one line and no scolding.';

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
          <button type="button" className="gym-retry" onClick={view.retry}>Retry</button>
        </p>
      </>
    );
  }

  const { session, sets } = view.data.detail;
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
                  <li key={set.id} className={set.kind === 'warmup' ? 'gym-set gym-set-warmup' : 'gym-set'}>
                    <span className="gym-set-mark" aria-hidden="true">{set.kind === 'warmup' ? '·' : '✓'}</span>
                    <span className="gym-set-load">{setLoadLabel(set)}</span>
                    {set.rpe != null && <span className="gym-set-rpe">rpe {set.rpe}</span>}
                    {note && <span className="gym-set-plan">{note}</span>}
                    {set.note && <span className="gym-set-note">{set.note}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {frozen && sets.length > 0 && <p className="gym-detail-thesis">{PLAN_BESIDE_ACTUAL}</p>}
      {/* The same two doors the finish screen carries, at the other end of a session's life: a
          workout worth asking about, or sending to a coach, is usually one somebody went back and
          looked at. The chat is never offered MID-SESSION (§L, and ARCHITECTURE §12 cuts "any chat
          not attached to one finished workout") — this screen is the mirror of a workout still
          running, and an answer about a session that is still changing is out of date before it is
          read. */}
      {isFinished(session) && <CoachPanel sessionId={id} />}
      <CoachShare sessionId={id} />
    </>
  );
}
