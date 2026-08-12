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
  clockOf, dayLabel, durLabel, fmt, isFinished, nameOfMovement, NO_ROUTINE, recordHref,
  routineNameOf, sessionHref, setCountLabel,
} from './log.js';
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
