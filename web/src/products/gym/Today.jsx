// TODAY — the one question this room answers: what am I doing right now. On the web the answer is
// the phone's to make: workouts start there, and this screen shows the mirror, never an absence
// (backend/products/gym/ARCHITECTURE.md §11.2). A session running is drawn as it happens —
// read-only, on the poll the shared hook keeps — and a session not running is said in words rather
// than in a greyed-out control, which is the one shape that would make the division of labour read
// as a restriction.
//
// The mirror still never says "resting", and the reason moved rather than went away. The rest target
// is the ACCOUNT's now (§I, settings/preferences.js) instead of the phone's, so this surface can
// name it — but knowing the target is not knowing whether the lifter is resting, walking to another
// rack, or already back under the bar. So the band says the digits it can stand behind, "last set
// 1:47 ago", with the target beside them and no claim between the two. It sounds nothing either: the
// clock between sets runs on the phone, where the workout is, and a browser tab cannot promise an
// alarm that survives a locked screen.

import React, { useEffect, useState } from 'react';
import {
  clockOf, dayLabel, durLabel, fmt, isFinished, nameOfMovement, NEW_ROUTINE_ID, NO_ROUTINE,
  recordHref, routineHref, routineNameOf, sessionHref, setCountLabel,
} from './log.js';
import { AskDoor } from './ask/AskRoom.jsx';
import { PendingProposals } from './Proposals.jsx';
import { restLabel } from './settings/preferences.js';

const BEAT_MS = 500;

export function Today({ log }) {
  if (log.phase === 'loading') return <p className="gym-quiet">Opening the log…</p>;
  if (log.phase === 'failed') return <p className="gym-read-failed">The log didn’t load. Open it again when you have signal.</p>;

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

      {/* THE CARD IS THE NOTIFICATION (§B4). A proposal an agent wrote waits on Today and on the
          routine it touches, and it waits in both places until a tap settles it — this product has
          no notifications and this is the reason it does not need any. It is drawn on a workout
          running as readily as on a quiet Tuesday: reading a diff is not a mid-session act, but the
          card is a line of text and hiding it while the phone is busy would mean a lifter who only
          ever opens this desk mid-workout never learns a proposal exists. */}
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

      {/* THE BAND AT THE BOTTOM (§L). On a phone this band carries the two Starts and Ask beside
          them; at the desk no session starts (§11), so Ask is the whole of it — which is fitting,
          because "never offered mid-session" is exactly what a phone is doing most of the time and
          this is the surface that is never in one. It goes while a workout is running, and the
          server refuses one anyway (409 ask-session-open) — the door is the rule's first half and
          not its only one. */}
      <AskDoor training={log.session != null} />
    </section>
  );
}

// AN EMPTY LOG, AT THE DESK — canon screen 1, and since 13 Aug the half this surface CAN draw is
// the primary. That screen leads with `Build a routine` (routine-first: home is the plan, nothing
// starts by itself), and building a routine is a desk activity that exists today — so the verb
// lands here whole. The half the desk may not draw is `Just start logging`: a session cannot start
// here (§11), the phone owns the open workout, so the free-form path is named as the phone's and
// never offered as a button.
//
// The sentence over it states both doors in the new order: the routine written first is the path,
// and the session that names itself afterwards is the one that survives as the second. It says what
// will HAPPEN, and it is the whole of what this room says for itself.
//
// THE ARGUMENT UNDER IT IS GONE (W9). A dashed box read "no tour, no sample program, no questions
// about your goals" — the design's own case for the setup wizard it refuses to build, drawn in front
// of a lifter who never asked for one. That case is worth making, and the place to make it is beside
// the screen rather than on it: it now lives in §A's notes on the board and in this comment. Nothing
// counts how many times the room was walked past.
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

// The live session as it happens, read-only (§11.2): the routine and the elapsed clock on one line,
// the movement the last set went into on the next — its number, its load, and how long ago — and
// the day's sets of that movement under them. Every clock is recomputed from an instant on a local
// beat, so the numbers move between polls and survive a backgrounded tab; the facts themselves only
// change when the poll answers.
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
            {/* THE NAME IS A DOOR (§H), here as everywhere a movement is named. This room holds
                nothing a lifter typed — the mirror is a read, and the workout it draws is running
                on the phone — so leaving it costs the next poll and nothing else. */}
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
