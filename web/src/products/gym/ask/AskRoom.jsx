// ASK (§L) — the second door onto the tools an agent drives over MCP, for a lifter who has not got
// an agent of their own. Same log, the same catalog, the same typed diffs, the same tap: what is
// different is only that the model sits on our side of the wire and we pay for its tokens.
//
// IT IS A ROOM AND NOT A FOURTH TAB, and not a panel bolted under one finished workout either. The
// tab bar is the app's three rooms and a chat is not a place you live, so Ask is reached from
// Today's band and from a proposal, and it is left the way any other screen is left. Widening it
// from one workout to the whole log is what made it a room: the questions worth asking — "bench has
// been stuck for three weeks" — are about the log and not about Tuesday.
//
// AND IT IS THE DESK'S FEATURE BY CONSTRUCTION. "Never mid-session" is exactly what a phone is doing
// most of the time, so the surface that is never mid-session is this one.
//
// EVERY ANSWER STATES WHAT IT READ, and the count is the SERVER's — the rows it served this
// connection, deduped by id (ask.js). Nothing here sums a number, because a number this layer
// computed would be an audit the model could have written itself.
//
// IT PROPOSES AND IT NEVER WRITES. A routine change arrives as a proposal id, which this room opens
// as the same diff every other door opens, on the same all-or-none tap. A logged set it cannot touch
// at all, at any grant level — so the room says where that correction lives instead of leaving a
// lifter to find the refusal by asking for one.
//
// AND IT CAN BE ABSENT. A deployment with no model wired never mounts the route, so the first ask
// can come back a bare 404 — in which case the composer goes and the question the lifter typed stays
// on screen as their own turn, unanswered. Nothing they wrote disappears quietly.

import React, { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { gymApi } from '../gymApi.js';
import { ASK_HREF, proposalHref } from '../log.js';
import { changeLabel, diffRows, reviewLabel } from '../proposals.js';
import { DiffRow } from '../Proposals.jsx';
import { useGymRead } from '../useGymRead.js';
import {
  answerTurn, ASK_PLACEHOLDER, ASK_TERMS, ASK_TITLE, askFailure, FIX_IS_YOURS, FREE_DOOR_LINE,
  FREE_DOOR_VERB, MID_SESSION_NOTE, NO_ANSWER_NOTE, PROPOSAL_NOTE, questionTooLong, readLine,
  stepsLine, threadFor, threadFull, TOO_LONG_NOTE,
} from './ask.js';

// THE DOOR, and the one condition it is ever drawn under. §L: never offered mid-session — an answer
// about a workout that is still moving is out of date before it is read, and the server refuses one
// anyway (409 ask-session-open). The caller passes the fact rather than this reading the log itself:
// both hosts already hold the one read every room in gym shares, and a second read of it here would
// be a second thing that could disagree with the mirror three lines above.
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
  // { from: 'lifter' | 'ask', text, steps?, read?, proposals? } — the whole conversation, held here
  // and nowhere else. The server keeps none of it, so what is on screen IS the thread.
  const [turns, setTurns] = useState([]);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  // Set to the sentence that closed the room — no Ask on this deployment, or an account that went.
  // Either way asking again is not the repair, so the composer goes and this takes its place. It
  // holds the SENTENCE rather than a flag because the two reasons are different facts and printing
  // the wrong one is exactly the misinformation this room exists to avoid.
  const [closed, setClosed] = useState('');

  const ask = async () => {
    const question = draft.trim();
    if (question === '' || asking) return;
    // The cap is bytes and the field counts characters, so this is where a long question stops —
    // on screen, with the draft intact, rather than in a 400 that took the words with it.
    if (questionTooLong(question)) {
      setNote(TOO_LONG_NOTE);
      return;
    }
    const thread = threadFor(turns, question);
    // The lifter's turn lands on screen BEFORE the request — so a reply that never comes leaves the
    // question they asked, not a cleared box and no explanation.
    setTurns((held) => [...held, { from: 'lifter', text: question }]);
    setDraft('');
    setNote('');
    setAsking(true);
    try {
      const reply = await gymApi.ask(thread);
      // A 200 IS NOT YET AN ANSWER. Every answer states what it read (§L), so a body with no
      // receipt in it is not something this room may draw — `answerTurn` is the one door onto a
      // turn, and a reply it refuses is said as the model not having answered, which is what it is.
      // The lifter's question stays on screen either way.
      const answer = answerTurn(reply);
      if (answer) setTurns((held) => [...held, answer]);
      else setNote(NO_ANSWER_NOTE);
    } catch (error) {
      const failure = askFailure(error);
      if (failure.gone) setClosed(failure.note);
      else setNote(failure.note);
    }
    setAsking(false);
  };

  return (
    <section className="gym-ask">
      <a className="gym-back" href="#/gym">
        <ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Today
      </a>
      {/* The header is the whole disclosure and it is on screen before a word is typed: what Ask
          reaches, and — in the same breath — that proposing is the most it can do. There is no plan
          chip beside it, because Ask is not behind a plan: it is open, with a cap that says so in
          words when it is reached. */}
      <header className="gym-ask-head">
        <h1 className="gym-title">{ASK_TITLE}</h1>
        <p className="gym-ask-terms">{ASK_TERMS}</p>
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
        onStartAgain={() => { setTurns([]); setNote(''); }}
      />
    </section>
  );
}

// The room's one branch, and it is a branch about whether there is anything to type INTO — never
// about what the answers look like. A composer nobody could get an answer from is the failure the
// old panel's paywall rule named: nobody types a question about their squats and then finds out it
// was never going to be answered.
function AskBody({ log, turns, asking, note, closed, draft, setDraft, onAsk, onStartAgain }) {
  // The shared read has not told us whether a workout is running yet, and "not training" is exactly
  // the wrong guess to make while it is in flight.
  if (log.phase === 'loading') return <p className="gym-quiet">Opening the log…</p>;

  // NEVER MID-SESSION, said before anything is typed. The server is the floor under this rule and
  // not a substitute for it (409 ask-session-open) — which is also why a failed log read still
  // draws the composer below: this surface guesses nothing about a workout it could not read, and
  // the 409 says it properly if there is one.
  if (log.session) {
    return (
      <>
        <p className="gym-ask-closed">{MID_SESSION_NOTE}</p>
        <p className="gym-ask-note">Your workout is on your phone. This room is here when it is over.</p>
      </>
    );
  }

  const full = threadFull(turns);

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

      {/* A THREAD IS EIGHT TURNS AND THE ROOM SAYS SO RATHER THAN LETTING SEND FAIL. Nothing is kept
          between conversations anyway — the server holds none of this — so starting again costs the
          lifter exactly the context that is on the screen in front of them. */}
      {!closed && full && (
        <div className="gym-ask-full">
          <p className="gym-ask-note">That’s as long as one conversation goes here.</p>
          <button type="button" className="gym-ask-again" onClick={onStartAgain}>Start a new one</button>
        </div>
      )}

      {/* AND NO CHIPS ABOVE IT. §L draws three suggested follow-ups over the composer; they are
          deliberately not built, and not because they were forgotten. A follow-up has to come out
          of the answer above it, and nothing on this wire carries one — so a client writing "Deload
          week?" for itself would be the room composing the lifter's next question about numbers it
          never read, which is a personality, and §L bans one in the same breath it asks for chips.
          Openers before the first question are a different object and also absent here: this room
          does not speak first, and an empty one says the free door and nothing else. Android
          declared the same omission for the same reason (gym/domain/Ask.kt). */}
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
              // Enter sends, shift+Enter is a newline — the shape every composer in this brand uses.
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

      {/* WHAT IT HANDS BACK, standing rather than waiting to be refused. Ask cannot edit a set you
          lifted at any grant level, so the room names the door that can — §G18's, where every set in
          a workout is a door onto its own fix. It is one line and it is always true, which is the
          only honest shape available: nothing on this wire tells this screen WHICH set a refusal was
          about, so nothing here may name one. */}
      {!closed && (
        <p className="gym-ask-hand-back">
          {FIX_IS_YOURS}
          <a className="gym-ask-hand-back-door" href="#/gym/log">Open the log ›</a>
        </p>
      )}
    </>
  );
}

// THE EMPTY ROOM POINTS AT THE FREE DOOR — and it is the only thing an empty room says, because Ask
// does not speak first. No greeting, no suggestions, no "what would you like to know": the sentence
// on screen is about the better option, and the better option is not this one.
function FreeDoor() {
  return (
    <section className="gym-ask-empty">
      <p className="gym-ask-free">{FREE_DOOR_LINE}</p>
      <a className="gym-ask-free-door" href="#/connect">{FREE_DOOR_VERB}</a>
    </section>
  );
}

// ONE ANSWER: the prose, whatever it proposed, and then the two lines that make it checkable. The
// order is canon's — the receipt is UNDER the answer, because it is evidence about the thing above
// it and not a preamble to it.
//
// The receipt is drawn unconditionally and that is the point: a turn with no receipt was never made
// (ask.js `answerTurn`), so there is no branch here in which prose stands on its own.
//
// WHAT §L DRAWS THAT THIS DOES NOT: the four-row mono block of dated sets the model reasoned from,
// under the prose and above the read line. The wire carries no rows — `POST /v1/gym/ask` answers
// `answer`, `steps`, `read` and `proposals` and nothing else (backend adapters/http/AskApi.cpp) —
// and reading them back off the log here to fill the block would be a SECOND account of the same
// answer, assembled by the client, which is exactly the laundered receipt the whole design refuses.
// So this holds the true thing we have — how much was served, and which tools served it — and the
// rows arrive the wave the server hands them over. iOS says the same thing in the same place
// (WindmillGym/AskScreen.swift); no surface draws rows today.
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

// A PROPOSAL ASK MINTED, drawn as the same object every other door draws (§D14, proposals.js). Only
// the id comes back on the wire, which is the point: it is read from the store like any other
// proposal, so a diff written by Ask and a diff written by a lifter's own Claude are indistinguishable
// in type, in mechanism and on screen — provenance is a column and not a fork.
//
// The rows are the diff's own renderer rather than a compact copy of it. A second reading of a
// change would be the product disagreeing with itself about one routine on two screens, and this
// card is the first place a lifter sees the change at all.
function AskProposal({ id, catalog }) {
  const view = useGymRead(() => gymApi.proposal(id), [id]);

  // Minted means it exists, so a read that did not answer is this screen's problem and not the
  // proposal's — and the door is what the lifter actually needs either way. `absent` lands here too:
  // a proposal settled on another tab between the mint and this read is still a proposal to open.
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
