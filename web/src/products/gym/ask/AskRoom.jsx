import React, { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { gymApi } from '../gymApi.js';
import { ASK_HREF, CONNECT_HREF, proposalHref, THREADS_HREF } from '../log.js';
import { mintId } from '../mint.js';
import { changeLabel, diffRows, reviewLabel } from '../proposals.js';
import { DiffRow } from '../Proposals.jsx';
import { useGymRead } from '../useGymRead.js';
import {
  answerTurn, ASK_PLACEHOLDER, ASK_TERMS, ASK_TITLE, askFailure, FIX_IS_YOURS, FREE_DOOR_LINE,
  FREE_DOOR_VERB, MID_SESSION_NOTE, NO_ANSWER_NOTE, PROPOSAL_NOTE, questionTooLong, readLine,
  stepsLine, THREAD_FULL_NOTE, THREAD_PREFIX, threadFull, TOO_LONG_NOTE,
} from './ask.js';
import { THREADS_TITLE } from './threads.js';

export function AskDoor({ training }) {
  if (training) return null;
  return (
    <a className="gym-ask-door" href={ASK_HREF}>
      <span className="gym-ask-door-dot" aria-hidden="true" />
      <span className="gym-ask-door-verb">{ASK_TITLE}</span>
      <span className="gym-ask-door-line">{ASK_TERMS}</span>
    </a>
  );
}

export function AskRoom({ log }) {
  // turns: { from: 'lifter' | 'ask', text, steps?, read?, proposals? }
  const [turns, setTurns] = useState([]);
  const [threadId, setThreadId] = useState(() => mintId(THREAD_PREFIX));
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [closed, setClosed] = useState('');
  const [refusedFull, setRefusedFull] = useState(false);

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
      if (failure.fresh) setThreadId(mintId(THREAD_PREFIX));
      if (failure.full) setRefusedFull(true);
      else if (failure.gone) setClosed(failure.note);
      else setNote(failure.note);
    }
    setAsking(false);
  };

  return (
    <section className="gym-ask">
      <a className="gym-back" href="#/gym">
        <ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Today
      </a>
      <header className="gym-ask-head">
        <div className="gym-ask-titles">
          <h1 className="gym-title">{ASK_TITLE}</h1>
          <p className="gym-ask-terms">{ASK_TERMS}</p>
        </div>
        <a className="gym-ask-threads-door" href={THREADS_HREF}>{THREADS_TITLE} ›</a>
      </header>

      <AskBody
        log={log}
        turns={turns}
        asking={asking}
        note={note}
        closed={closed}
        draft={draft}
        setDraft={setDraft}
        onAsk={ask}
        refusedFull={refusedFull}
        onStartAgain={() => {
          setTurns([]); setNote(''); setRefusedFull(false); setThreadId(mintId(THREAD_PREFIX));
        }}
      />
    </section>
  );
}

function AskBody({ log, turns, asking, note, closed, draft, setDraft, onAsk, onStartAgain, refusedFull }) {
  if (log.phase === 'loading') return <p className="gym-quiet">Opening the log…</p>;

  if (log.session) {
    return (
      <>
        <p className="gym-ask-closed">{MID_SESSION_NOTE}</p>
        <p className="gym-ask-note">Your workout is on your phone. This room is here when it is over.</p>
      </>
    );
  }

  const full = refusedFull || threadFull(turns);

  return (
    <>
      {turns.length === 0 && <FreeDoor />}

      {turns.length > 0 && (
        <ol className="gym-ask-thread">
          {turns.map((turn, index) => (
            <li
              className={turn.from === 'lifter' ? 'gym-ask-turn is-lifter' : 'gym-ask-turn is-ask'}
              key={`${turn.from}-${index}`}
            >
              {turn.from === 'lifter' ? (
                <p className="gym-ask-text">{turn.text}</p>
              ) : (
                <Answer turn={turn} catalog={log.catalog} />
              )}
            </li>
          ))}
        </ol>
      )}

      {asking && <p className="gym-ask-note" role="status">Reading your log…</p>}
      {note && <p className="gym-ask-note">{note}</p>}

      {closed && <p className="gym-ask-closed">{closed}</p>}

      {!closed && full && (
        <div className="gym-ask-full">
          <p className="gym-ask-note">{THREAD_FULL_NOTE}</p>
          <button type="button" className="gym-ask-again" onClick={onStartAgain}>Start a new one</button>
        </div>
      )}

      {!closed && !full && (
        <div className="gym-ask-compose">
          <textarea
            className="gym-ask-input"
            value={draft}
            rows={2}
            maxLength={1000}
            placeholder={ASK_PLACEHOLDER}
            aria-label={ASK_PLACEHOLDER}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onAsk(); }
            }}
          />
          <button
            type="button"
            className={draft.trim() === '' || asking ? 'gym-ask-send is-inert' : 'gym-ask-send'}
            onClick={onAsk}
            aria-busy={asking}
            aria-label="Send"
          >
            {asking ? '…' : '↑'}
          </button>
        </div>
      )}

      {!closed && (
        <p className="gym-ask-hand-back">
          {FIX_IS_YOURS}
          <a className="gym-ask-hand-back-door" href="#/gym/log">Open the log ›</a>
        </p>
      )}
    </>
  );
}

function FreeDoor() {
  return (
    <section className="gym-ask-empty">
      <p className="gym-ask-free">{FREE_DOOR_LINE}</p>
      <a className="gym-ask-free-door" href={CONNECT_HREF}>{FREE_DOOR_VERB}</a>
    </section>
  );
}

function Answer({ turn, catalog }) {
  return (
    <>
      <p className="gym-ask-text">{turn.text}</p>
      {turn.proposals?.map((id) => <AskProposal key={id} id={id} catalog={catalog} />)}
      <p className="gym-ask-read">{readLine(turn.read)}</p>
      <p className="gym-ask-steps">{stepsLine(turn.steps)}</p>
    </>
  );
}

function AskProposal({ id, catalog }) {
  const view = useGymRead(() => gymApi.proposal(id), [id]);

  if (view.phase !== 'ready') {
    return (
      <a className="gym-ask-proposal-door" href={proposalHref(id)}>Open the proposal ›</a>
    );
  }

  const proposal = view.data;
  return (
    <article className="gym-ask-proposal">
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
      <p className="gym-ask-proposal-note">{PROPOSAL_NOTE}</p>
    </article>
  );
}
