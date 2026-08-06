// THE END OF A SESSION — three facts, at most one line of meaning, and the movement-by-movement
// comparison under it. Everything drawn here is the `Review` the store computed: no e1RM is
// calculated on this surface and no record is decided on it, so web and iOS can never disagree about
// which line is the loud one (review.js).
//
// THE EMPTY SLOT IS THE DESIGN. On the ~190 sessions in 200 that earn nothing, the space a record
// would occupy is simply empty — nothing says well done, nothing implies the session was wasted, and
// there is no streak and no score to fill it with. The coach share below it is not that slot's
// filler: it is offered on every session alike, it says nothing about how the session went, and it
// is a link to one person and never a share sheet.
//
// It reads the session back rather than being handed it: the hook clears the live session the moment
// it closes, and a screen assembled from what was in memory a second ago would be a screen that
// cannot survive a reload — which is exactly what the lifter does when the log looks wrong.

import React, { useRef, useState } from 'react';
import { failureReason, gymApi } from './gymApi.js';
import {
  entryLabel, isFirstSession, nameOfMovement, routineNameOf, sessionHref, weekdayName,
} from './log.js';
import { mintId } from './logger/flushQueue.js';
import { comparison, finishHead, RECORD_TITLE, recordSentence, statTiles } from './review.js';
import { routineFromSession } from './routines.js';
import { CoachShare } from './share/CoachShare.jsx';
import { useGymRead } from './useGymRead.js';

export function FinishScreen({ id, live }) {
  const view = useGymRead(
    () => Promise.all([
      gymApi.session(id),
      gymApi.review(id),
      gymApi.exercises(),
      // Two rows settle "your first session": the log reads newest first, so any earlier session is
      // the one immediately under this one (log.js).
      gymApi.sessions({ limit: 2 }),
    ]).then(([detail, review, catalog, recent]) => (detail ? { detail, review, catalog, recent } : null)),
    [id],
  );

  if (view.phase === 'loading') return <p className="gym-quiet">Closing the session…</p>;
  if (view.phase === 'absent') {
    return (
      <>
        <p className="gym-quiet">That session isn’t in your log.</p>
        <a className="gym-back" href="#/gym">Today</a>
      </>
    );
  }
  if (view.phase === 'failed') {
    // The session is closed either way — that write landed before this screen existed. So this says
    // what could not be READ, and never that anything was lost.
    return (
      <>
        <p className="gym-read-failed">
          The session is saved, but this didn’t load.
          <button type="button" className="gym-retry" onClick={view.retry}>Retry</button>
        </p>
        <a className="gym-back" href={sessionHref(id)}>Session detail</a>
      </>
    );
  }

  const { detail, review, catalog, recent } = view.data;
  const { session, sets } = detail;
  const head = finishHead({
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    routine: routineNameOf(session),
    slight: review.slight,
    first: isFirstSession(recent, id),
  });
  const record = recordSentence(review.record, catalog);
  const against = comparison(review.against, catalog);

  return (
    <section className="gym-finish-screen">
      <h1 className="gym-title">{head.title}</h1>
      <p className="gym-finish-subtitle">{head.subtitle}</p>
      <p className="gym-finish-when">{head.when}</p>

      <ul className="gym-stats">
        {statTiles(review.stats).map((tile) => (
          <li className="gym-stat" key={tile.label}>
            <span className="gym-stat-value">{tile.value}</span>
            <span className="gym-stat-label">{tile.label}</span>
          </li>
        ))}
      </ul>

      {record && (
        <section className="gym-record">
          <h2 className="gym-record-title">{RECORD_TITLE}</h2>
          <p className="gym-record-line">{record}</p>
        </section>
      )}

      {against && (
        <section className="gym-against">
          <h2 className="gym-against-title">{against.title}</h2>
          <ul className="gym-against-rows">
            {against.rows.map((row) => (
              <li className="gym-against-row" key={row.exerciseId}>
                <span className="gym-against-movement">{row.movement}</span>
                <span className="gym-against-detail">{row.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {review.slight && <ShortSession id={id} live={live} />}
      {!review.slight && !session.routineId && (
        <KeepAsRoutine session={session} sets={sets} catalog={catalog} live={live} />
      )}

      {/* Not offered on a short session, and that is a decision rather than an omission: a screen
          asking "keep it in the log, or drop it?" must not also offer to send it to somebody. The
          session detail carries the same door, so a session kept is one tap from being shared. */}
      {!review.slight && <CoachShare sessionId={id} />}

      {!review.slight && (
        <div className="gym-finish-foot">
          <a className="gym-finish-detail" href={sessionHref(id)}>Session detail</a>
          <a className="gym-finish-done" href="#/gym">Done</a>
        </div>
      )}
    </section>
  );
}

// The one destructive action in the product, and it sits here because a three-set session is usually
// a phone left running rather than a workout. It is offered only after the close — while a session
// is open, only the device holding the offline queue knows every set landed (gymApi.js).
function ShortSession({ id, live }) {
  const [dropping, setDropping] = useState(false);
  return (
    <section className="gym-short">
      <p className="gym-short-line">A session this short is usually a phone left running. Keep it in the log, or drop it?</p>
      <div className="gym-finish-foot">
        <a className="gym-short-keep" href="#/gym">Keep it</a>
        <button
          type="button"
          className="gym-short-discard"
          onClick={async () => {
            if (dropping) return;
            setDropping(true);
            try {
              await gymApi.discardSession(id);
              // The list on screen still holds it, and the lifter is about to look at that list.
              live.reloadLog();
              live.say('That session is out of your log.');
              window.location.hash = '#/gym';
            } catch (error) {
              setDropping(false);
              live.say(`That session wasn’t discarded — ${failureReason(error)}.`);
            }
          }}
        >
          Discard session
        </button>
      </div>
    </section>
  );
}

// "Keep this as a routine" (canon screen 3) — the first routine most lifters ever have, and a
// by-product of a session rather than a form they filled in. Nothing is created until the tap:
// declining costs nothing and the offer comes back next session, because a routine exists because
// somebody named it.
//
// The name field opens on the day it happened, which is a value on screen to be typed over and not
// a name anything wrote on its own — a lifter who saves it unchanged has read it and chosen it.
function KeepAsRoutine({ session, sets, catalog, live }) {
  const [name, setName] = useState(() => weekdayName(session.startedAt));
  const [offered, setOffered] = useState(true);
  const [saving, setSaving] = useState(false);
  // Minted once, so a create that times out and is tapped again is the same document arriving twice
  // rather than two routines with one name — the id IS the idempotency key (gymApi.js).
  const minted = useRef(null);
  if (minted.current === null) minted.current = mintId('rt_');
  // The default position is the top, and it only ever separates routines that share a last-trained
  // instant: a routine born from a session has never been trained, so what actually places it is
  // that fact — and Today's card says the same thing about it (routines.js).
  const composed = routineFromSession({ id: minted.current, name: name.trim(), sets });
  if (!offered || composed.entries.length === 0) return null;

  return (
    <section className="gym-keep">
      <h2 className="gym-keep-title">Keep this as a routine</h2>
      <div className="gym-keep-name">
        <input
          className="gym-keep-input"
          value={name}
          maxLength={80}
          aria-label="Routine name"
          onChange={(event) => setName(event.target.value)}
        />
        <span className="gym-keep-hint">tap to rename</span>
      </div>
      <ul className="gym-keep-entries">
        {composed.entries.map((entry) => (
          <li className="gym-keep-entry" key={entry.exerciseId}>
            <span>{nameOfMovement(catalog, entry.exerciseId)}</span>
            <span className="gym-keep-target">{entryLabel(entry)}</span>
          </li>
        ))}
      </ul>
      <p className="gym-keep-line">
        In the order you did them, with the weights you actually used as next week’s targets.
      </p>
      <div className="gym-finish-foot">
        <button
          type="button"
          className={name.trim() === '' || saving ? 'gym-keep-save is-inert' : 'gym-keep-save'}
          onClick={async () => {
            if (name.trim() === '' || saving) return;
            setSaving(true);
            try {
              await gymApi.createRoutine(composed);
              setOffered(false);
              live.say(`${name.trim()} is in your routines.`);
            } catch (error) {
              setSaving(false);
              live.say(`That routine wasn’t saved — ${failureReason(error)}.`);
            }
          }}
        >
          Save routine
        </button>
        <button type="button" className="gym-keep-decline" onClick={() => setOffered(false)}>
          Just keep the session
        </button>
      </div>
    </section>
  );
}
