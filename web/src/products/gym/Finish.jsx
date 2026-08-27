import React, { useRef, useState } from 'react';
import { Button } from '../../design-system/index.js';
import { Back } from './Back.jsx';
import { failureReason, gymApi } from './gymApi.js';
import {
  entryLabel, isFirstSession, nameOfMovement, recordHref, routineNameOf, sessionHref, weekdayName,
} from './log.js';
import { mintId } from './mint.js';
import { comparison, finishHead, RECORD_TITLE, recordSentence, SESSION_DELETED, statTiles } from './review.js';
import { routineFromSession } from './routines.js';
import { ShareWorkout } from './share/ShareWorkout.jsx';
import { useGymRead } from './useGymRead.js';

export function FinishScreen({ id, log }) {
  const view = useGymRead(
    () => Promise.all([
      gymApi.session(id),
      gymApi.review(id),
      gymApi.exercises(),
      gymApi.sessions({ limit: 2 }),
    ]).then(([detail, review, catalog, recent]) => (detail ? { detail, review, catalog, recent } : null)),
    [id],
  );

  if (view.phase === 'loading') return <p className="gym-quiet">Opening the review…</p>;
  if (view.phase === 'absent') {
    return (
      <>
        <Back href="#/gym/log">The log</Back>
        <p className="gym-quiet">That session isn’t in your log.</p>
      </>
    );
  }
  if (view.phase === 'failed') {
    return (
      <>
        <p className="gym-read-failed">
          The session is saved, but this didn’t load.
          <Button variant="secondary" size="sm" onClick={view.retry}>Retry</Button>
        </p>
        <Back href={sessionHref(id)}>Session detail</Back>
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
                <a className="gym-against-movement gym-movement-door" href={recordHref(row.exerciseId)}>
                  {row.movement}
                </a>
                <span className="gym-against-detail">{row.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {review.slight && <ShortSession id={id} log={log} />}
      {!review.slight && !session.routineId && (
        <KeepAsRoutine session={session} sets={sets} catalog={catalog} log={log} />
      )}

      {!review.slight && <ShareWorkout sessionId={id} />}

      {!review.slight && (
        <div className="gym-finish-foot">
          <a className="gym-finish-detail" href={sessionHref(id)}>Session detail</a>
          <a className="gym-finish-done" href="#/gym">Done</a>
        </div>
      )}
    </section>
  );
}

// Discarding a workout is a withheld delete like the others: the session leaves the log at once,
// nothing reaches the store for the length of the window, and the transient carries the way back.
// There is no confirmation, because a dialog in front of an act that can be undone is ceremony.
function ShortSession({ id, log }) {
  const discard = () => {
    log.withhold({
      kind: 'session',
      id,
      line: SESSION_DELETED,
      send: async () => {
        await gymApi.discardSession(id);
        await log.reloadLog();
      },
      refused: (error) => log.say(`That session wasn’t discarded — ${failureReason(error)}.`),
    });
    window.location.hash = '#/gym';
  };

  return (
    <section className="gym-short">
      <p className="gym-short-line">Keep it in the log, or drop it?</p>
      <div className="gym-finish-foot">
        <a className="gym-short-keep" href="#/gym">Keep it</a>
        <button type="button" className="gym-short-discard" onClick={discard}>
          Discard session
        </button>
      </div>
    </section>
  );
}

function KeepAsRoutine({ session, sets, catalog, log }) {
  const [name, setName] = useState(() => weekdayName(session.startedAt));
  const [offered, setOffered] = useState(true);
  const [saving, setSaving] = useState(false);
  // The id is the idempotency key: mint once so a retried create is one routine.
  const minted = useRef(null);
  if (minted.current === null) minted.current = mintId('rt_');
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
      <p className="gym-keep-line">Today’s weights become next week’s targets.</p>
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
              log.say(`${name.trim()} is in your routines.`);
            } catch (error) {
              setSaving(false);
              log.say(`That routine wasn’t saved — ${failureReason(error)}.`);
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
