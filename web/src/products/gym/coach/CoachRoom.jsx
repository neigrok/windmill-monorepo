import React, { useState } from 'react';
import { gymApi } from '../gymApi.js';
import { CONNECT_HREF, NOTES_HREF, proposalHref, THREADS_HREF } from '../log.js';
import { mintId } from '../mint.js';
import {
  CARD_ROW_CAP, CARD_ROW_KINDS, countedLabel, diffRows, isPending, moreRowsLabel, receiptLine,
  stateChip, STILL_WAITING, summaryLine,
} from '../proposals.js';
import { DiffRow, ProposalReview, ReviewDoor } from '../Proposals.jsx';
import { useGymRead } from '../useGymRead.js';
import {
  ALLOWANCE_LINE, answerTurn, askFailure, COACH_PLACEHOLDER, COACH_TERMS, COACH_TITLE, FIX_IS_YOURS,
  FREE_DOOR_LINE, FREE_DOOR_VERB, MID_SESSION_NOTE, NO_ANSWER_NOTE, NOTES_DOOR, PROPOSAL_NOTE,
  questionTooLong, readLine, stepsLine, THREAD_FULL_NOTE, THREAD_PREFIX, threadFull, TOO_LONG_NOTE,
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
  // Null, or the cap-reached state with the sentence the server sent for it: BOTH 429s land here,
  // and the state says whichever ceiling was hit rather than a constant of its own.
  const [capped, setCapped] = useState(null);

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
      else if (failure.capped) setCapped({ note: failure.note, ceiling: Boolean(failure.ceiling) });
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
          setTurns([]); setNote(''); setRefusedFull(false); setCapped(null); setThreadId(mintId(THREAD_PREFIX));
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
                <Answer turn={turn} log={log} />
              )}
            </li>
          ))}
        </ol>
      )}

      {asking && <p className="gym-coach-note" role="status">Reading your log…</p>}
      {note && <p className="gym-coach-note">{note}</p>}

      {closed && <p className="gym-coach-closed">{closed}</p>}

      {/* The promise sits immediately above whatever holds the composer's place — except under the
          account's 30-day ceiling, where ten a day is not the rule that stopped the question and a
          promise standing on top of the sentence refusing it would be the one lie in the room. */}
      {!closed && !capped?.ceiling && <p className="gym-coach-allowance">{ALLOWANCE_LINE}</p>}

      {!closed && full && (
        <div className="gym-coach-full">
          <p className="gym-coach-note">{THREAD_FULL_NOTE}</p>
          <button type="button" className="gym-coach-again" onClick={onStartAgain}>Start a new one</button>
        </div>
      )}

      {!closed && !full && capped && <CapReached capped={capped} onStartAgain={onStartAgain} />}

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

// The moment an allowance is spent, whichever one it was: the sentence the server sent for it, the
// one door that is not rationed, and the way out of the conversation. Which of the two leads is the
// ceiling's to decide, and it is decided on the CODE the refusal arrived with, never on the sentence
// it printed. Under the day's ten a new conversation is the way back to the composer, so it leads.
// Under the account's 30-day ceiling a new conversation cannot take a question either, so the
// unrationed door leads and `Ask something new` goes quiet beneath it — a way out of this
// conversation, and not a way to an answer.
function CapReached({ capped, onStartAgain }) {
  const door = <a className="gym-coach-free-door" href={CONNECT_HREF}>{FREE_DOOR_VERB}</a>;
  const again = <button type="button" className="gym-coach-again" onClick={onStartAgain}>{NEW_THREAD_VERB}</button>;
  return (
    <div className={capped.ceiling ? 'gym-coach-capped is-ceiling' : 'gym-coach-capped'} role="status">
      <p className="gym-coach-closed">{capped.note}</p>
      {capped.ceiling ? <>{door}{again}</> : <>{again}{door}</>}
    </div>
  );
}

// The receipt is the honesty mechanism and is always visible; the step list opens behind it.
function Answer({ turn, log }) {
  const steps = stepsLine(turn.steps);
  return (
    <>
      <p className="gym-coach-text">{turn.text}</p>
      {turn.proposals?.map((id) => <CoachProposal key={id} id={id} log={log} />)}
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

// The card: the summary it wrote, how much it is, a skim of what moved, one affordance, and after a
// decision the receipt beneath it — derived from the server's reply, held only for this visit to the
// room. The document is drawn once, in the dialog behind Review — and the door to it stands in every
// state, because a card that counts rows it will not draw has to reach them. The counted phrase names
// no routine: the kicker and the summary above it both do.
function CoachProposal({ id, log }) {
  const view = useGymRead(() => gymApi.proposal(id), [id]);
  const [reviewing, setReviewing] = useState(false);
  const [receipt, setReceipt] = useState('');

  if (view.phase !== 'ready') {
    return (
      <a className="gym-coach-proposal-door" href={proposalHref(id)}>Open the proposal ›</a>
    );
  }

  const proposal = view.data;
  const pending = isPending(proposal);
  // What MOVED, and only what a card can draw: standing still is not news, and a rename or a reorder
  // is a claim about the document behind Review.
  const changed = diffRows(proposal).filter((row) => CARD_ROW_KINDS.includes(row.kind));
  return (
    <>
      <article className="gym-coach-proposal">
        <p className="gym-proposal-kicker">
          <span className="gym-proposal-dot" aria-hidden="true" />
          <span className="gym-proposal-name">{`Proposal · ${proposal.baseName}`}</span>
          <span className="gym-proposal-when">{pending ? STILL_WAITING : stateChip(proposal)?.toLowerCase()}</span>
        </p>
        <p className="gym-proposal-line">{summaryLine(proposal, proposal.baseName)}</p>
        <p className="gym-proposal-counted">{countedLabel(proposal)}</p>
        {/* A rename and a reorder are claims about the whole document, so they stay in the dialog;
            the count above has already said them. A proposal that only moves lines draws no rows. */}
        {changed.length > 0 && (
          <ul className="gym-diff">
            {changed.slice(0, CARD_ROW_CAP).map((row, index) => (
              <li className={`gym-diff-row is-${row.kind}`} key={`${index}-${row.exerciseId ?? row.kind}`}>
                <DiffRow row={row} catalog={log.catalog} />
              </li>
            ))}
            {changed.length > CARD_ROW_CAP && (
              <li className="gym-diff-row is-more">
                <span className="gym-diff-more">{moreRowsLabel(changed.length - CARD_ROW_CAP)}</span>
              </li>
            )}
          </ul>
        )}
        <ReviewDoor head={proposal} onReview={() => setReviewing(true)} />
        {/* A promise about what Apply will do is spent once Apply has been taken or turned down. */}
        {pending && <p className="gym-coach-proposal-note">{PROPOSAL_NOTE}</p>}
      </article>
      {receipt && <p className="gym-coach-receipt" role="status">{receipt}</p>}
      {reviewing && (
        <ProposalReview
          id={id}
          log={log}
          onClose={() => setReviewing(false)}
          onChanged={view.refresh}
          onSettled={(settled) => {
            setReviewing(false);
            setReceipt(receiptLine(settled));
            view.refresh();
          }}
        />
      )}
    </>
  );
}
