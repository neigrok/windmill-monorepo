import React, { useState } from 'react';
import { gymApi } from '../gymApi.js';
import { CONNECT_HREF, NOTES_HREF, proposalHref, THREADS_HREF } from '../log.js';
import { mintId } from '../mint.js';
import { changeLabel, diffRows, reviewLabel } from '../proposals.js';
import { DiffRow } from '../Proposals.jsx';
import { useGymRead } from '../useGymRead.js';
import {
  ALLOWANCE_LINE, answerTurn, askFailure, CAP_REACHED_NOTE, COACH_PLACEHOLDER, COACH_TERMS,
  COACH_TITLE, FIX_IS_YOURS, FREE_DOOR_LINE, FREE_DOOR_VERB, MID_SESSION_NOTE, NO_ANSWER_NOTE,
  NOTES_DOOR, PROPOSAL_NOTE, questionTooLong, readLine, stepsLine, THREAD_FULL_NOTE, THREAD_PREFIX,
  threadFull, TOO_LONG_NOTE,
} from './coach.js';
import { NEW_THREAD_VERB, THREADS_TITLE } from './threads.js';

// A tab root: no back link. Threads and one conversation are pushed screens under it.
export function CoachRoom({ log }) {
  // turns: { from: 'lifter' | 'ask', text, steps?, read?, proposals? } — `from` is the wire's enum.
  const [turns, setTurns] = useState([]);
  const [threadId, setThreadId] = useState(() => mintId(THREAD_PREFIX));
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [closed, setClosed] = useState('');
  const [refusedFull, setRefusedFull] = useState(false);
  const [capped, setCapped] = useState(false);

  const ask = async () => {
    const question = draft.trim();
    if (question === '' || asking) return;
    // The cap is bytes; the field counts characters.
    if (questionTooLong(question)) {
      setNote(TOO_LONG_NOTE);
      return;
    }
    setTurns((held) => [...held, { from: 'lifter', text: question }]);
    setDraft('');
    setNote('');
    setAsking(true);
    try {
      const reply = await gymApi.ask(threadId, question);
      const answer = answerTurn(reply);
      if (answer) setTurns((held) => [...held, answer]);
      else setNote(NO_ANSWER_NOTE);
    } catch (error) {
      const failure = askFailure(error);
      // The server stored nothing of a refused question: it is not a turn of the conversation, and
      // the words return to the composer for the next conversation.
      if (failure.refused) { setTurns((held) => held.slice(0, -1)); setDraft(question); }
      if (failure.fresh) setThreadId(mintId(THREAD_PREFIX));
      if (failure.full) setRefusedFull(true);
      else if (failure.capped) setCapped(true);
      else if (failure.gone) setClosed(failure.note);
      else setNote(failure.note);
    }
    setAsking(false);
  };

  return (
    <section className="gym-coach">
      <header className="gym-coach-head">
        <div className="gym-coach-titles">
          <h1 className="gym-title">{COACH_TITLE}</h1>
          <p className="gym-coach-terms">{COACH_TERMS}</p>
        </div>
        <a className="gym-coach-threads-door" href={THREADS_HREF}>{THREADS_TITLE} ›</a>
      </header>

      {/* A row, never a third icon in the head: the notes are the lifter's, not the room's. */}
      <a className="gym-coach-notes-door" href={NOTES_HREF}>
        <span className="gym-coach-notes-verb">{NOTES_DOOR}</span>
        <span className="gym-coach-notes-go" aria-hidden="true">›</span>
      </a>

      <CoachBody
        log={log}
        turns={turns}
        asking={asking}
        note={note}
        closed={closed}
        capped={capped}
        draft={draft}
        setDraft={setDraft}
        onAsk={ask}
        refusedFull={refusedFull}
        onStartAgain={() => {
          setTurns([]); setNote(''); setRefusedFull(false); setCapped(false); setThreadId(mintId(THREAD_PREFIX));
        }}
      />
    </section>
  );
}

function CoachBody({ log, turns, asking, note, closed, capped, draft, setDraft, onAsk, onStartAgain, refusedFull }) {
  if (log.phase === 'loading') return <p className="gym-quiet">Opening the log…</p>;

  if (log.session) {
    return (
      <>
        <p className="gym-coach-closed">{MID_SESSION_NOTE}</p>
        <p className="gym-coach-note">Your workout is on your phone. This room is here when it is over.</p>
      </>
    );
  }

  const full = refusedFull || threadFull(turns);

  return (
    <>
      {turns.length === 0 && <FreeDoor />}

      {turns.length > 0 && (
        <ol className="gym-coach-thread">
          {turns.map((turn, index) => (
            <li
              className={turn.from === 'lifter' ? 'gym-coach-turn is-lifter' : 'gym-coach-turn is-coach'}
              key={`${turn.from}-${index}`}
            >
              {turn.from === 'lifter' ? (
                <p className="gym-coach-text">{turn.text}</p>
              ) : (
                <Answer turn={turn} catalog={log.catalog} />
              )}
            </li>
          ))}
        </ol>
      )}

      {asking && <p className="gym-coach-note" role="status">Reading your log…</p>}
      {note && <p className="gym-coach-note">{note}</p>}

      {closed && <p className="gym-coach-closed">{closed}</p>}

      {/* The promise sits immediately above whatever holds the composer's place. */}
      {!closed && <p className="gym-coach-allowance">{ALLOWANCE_LINE}</p>}

      {!closed && full && (
        <div className="gym-coach-full">
          <p className="gym-coach-note">{THREAD_FULL_NOTE}</p>
          <button type="button" className="gym-coach-again" onClick={onStartAgain}>Start a new one</button>
        </div>
      )}

      {!closed && !full && capped && <CapReached onStartAgain={onStartAgain} />}

      {!closed && !full && !capped && (
        <div className="gym-coach-compose">
          <textarea
            className="gym-coach-input"
            value={draft}
            rows={2}
            maxLength={1000}
            placeholder={COACH_PLACEHOLDER}
            aria-label={COACH_PLACEHOLDER}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onAsk(); }
            }}
          />
          <button
            type="button"
            className={draft.trim() === '' || asking ? 'gym-coach-send is-inert' : 'gym-coach-send'}
            onClick={onAsk}
            aria-busy={asking}
            aria-label="Send"
          >
            {asking ? '…' : '↑'}
          </button>
        </div>
      )}

      {!closed && (
        <p className="gym-coach-hand-back">
          {FIX_IS_YOURS}
          <a className="gym-coach-hand-back-door" href="#/gym/log">Open the log ›</a>
        </p>
      )}
    </>
  );
}

function FreeDoor() {
  return (
    <section className="gym-coach-empty">
      <p className="gym-coach-free">{FREE_DOOR_LINE}</p>
      <a className="gym-coach-free-door" href={CONNECT_HREF}>{FREE_DOOR_VERB}</a>
    </section>
  );
}

// The moment the allowance is spent: what to do next, the one door that is not rationed, and the way
// back — there is no clock, so a new conversation returns the composer and a question sent while
// still capped simply meets the 429 again.
function CapReached({ onStartAgain }) {
  return (
    <div className="gym-coach-capped">
      <p className="gym-coach-closed">{CAP_REACHED_NOTE}</p>
      <a className="gym-coach-free-door" href={CONNECT_HREF}>{FREE_DOOR_VERB}</a>
      <button type="button" className="gym-coach-again" onClick={onStartAgain}>{NEW_THREAD_VERB}</button>
    </div>
  );
}

// The receipt is the honesty mechanism and is always visible; the step list opens behind it.
function Answer({ turn, catalog }) {
  const steps = stepsLine(turn.steps);
  return (
    <>
      <p className="gym-coach-text">{turn.text}</p>
      {turn.proposals?.map((id) => <CoachProposal key={id} id={id} catalog={catalog} />)}
      {steps === null ? (
        <p className="gym-coach-read">{readLine(turn.read)}</p>
      ) : (
        <details className="gym-coach-trace">
          <summary className="gym-coach-read">{readLine(turn.read)}</summary>
          <p className="gym-coach-steps">{steps}</p>
        </details>
      )}
    </>
  );
}

function CoachProposal({ id, catalog }) {
  const view = useGymRead(() => gymApi.proposal(id), [id]);

  if (view.phase !== 'ready') {
    return (
      <a className="gym-coach-proposal-door" href={proposalHref(id)}>Open the proposal ›</a>
    );
  }

  const proposal = view.data;
  return (
    <article className="gym-coach-proposal">
      <p className="gym-proposal-kicker">
        <span className="gym-proposal-dot" aria-hidden="true" />
        <span>{`Proposal · ${proposal.baseName}`}</span>
        <span className="gym-proposal-when">{changeLabel(proposal.changeCount)}</span>
      </p>
      <ul className="gym-diff">
        {diffRows(proposal).map((row, index) => (
          <li className={`gym-diff-row is-${row.kind}`} key={`${index}-${row.exerciseId ?? row.kind}`}>
            <DiffRow row={row} catalog={catalog} />
          </li>
        ))}
      </ul>
      <a className="gym-proposal-review" href={proposalHref(proposal.id)}>{reviewLabel(proposal)}</a>
      <p className="gym-coach-proposal-note">{PROPOSAL_NOTE}</p>
    </article>
  );
}
