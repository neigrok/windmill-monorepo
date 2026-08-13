// PROPOSALS — what an agent may do to your program, which is ask. It reads, it proposes, and it
// never writes to a routine you already have (backend §2.9, canon §D14 and §L's safeguard ladder):
// every change it wants waits here, as a typed diff, until a thumb lands on Apply. This file is two
// of the places that fact reaches a lifter — the card that says a proposal is waiting, and the diff
// itself. The routine's own dated history is a third and lives with the routine (Routines.jsx),
// because it holds the day the routine was written as well as every proposal since; Ask draws a
// fourth, in its own room, off `DiffRow` below. A proposal minted by our model and one minted by a
// lifter's own Claude are the same object read the same way, which is exactly what `source` being a
// column buys.
//
// THE WEB IS THE DESK, AND READING A DIFF IS A SITTING-DOWN ACT. Everything else in gym's web
// surface is a mirror of a workout happening somewhere else (§11.2); this is the one screen the desk
// is the BEST place for, so it draws the whole document rather than a summary with a link to the
// phone.
//
// THE CARD IS THE NOTIFICATION. This product has no notifications and this is why it does not need
// them: a pending proposal sits on Today AND on the routine it touches, and waits there. Nothing
// expires it, nothing counts how often it was walked past, and nothing here dismisses it on a
// lifter's behalf — the two ways out are both taps on the diff.
//
// Nothing in this file decides anything: the reading rules are in proposals.js and the store's own
// count is what the button offers. The one write it makes is the settlement itself, on a tap.

import React, { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { ConnectInvitation } from './connect/ConnectLog.jsx';
import { failureReason, gymApi } from './gymApi.js';
import {
  arrivedLabel, ASK_HREF, nameOfMovement, proposalHref, recordHref, routineHref, ROUTINES_HREF,
  threadHref,
} from './log.js';
import {
  applyLabel, atomicLine, conversationOf, CONVERSATION_VERB, diffRows, documentLine, intentLine,
  isPending, reviewLabel, settledLine, sourceLabel, stateChip, summaryLine,
} from './proposals.js';
import { useGymRead } from './useGymRead.js';

// EVERY PROPOSAL WAITING, ON TODAY (canon screen 4). It rides the routines read rather than a
// proposals one, because a routine carries its own `pendingProposal` and the card needs the
// routine's NAME beside it — one request answers both, and the head alone would leave the card
// naming a routine by its id.
//
// A read that has not answered draws NOTHING, and so does one that failed. Silence here is an
// omission — the card is late — while a card drawn off a half-read would be an assertion, and the
// only assertion this component could make wrongly is "nothing is waiting for you".
export function PendingProposals() {
  const view = useGymRead(() => gymApi.routines(), []);
  if (view.phase !== 'ready') return null;
  const waiting = view.data.filter((routine) => routine.pendingProposal);
  if (waiting.length === 0) return null;
  return (
    <section className="gym-proposals">
      {waiting.map((routine) => (
        <ProposalCard key={routine.id} routine={routine} />
      ))}
    </section>
  );
}

function ProposalCard({ routine }) {
  const head = routine.pendingProposal;
  const consequence = intentLine(head, routine.name);
  return (
    <article className="gym-proposal-card">
      <p className="gym-proposal-kicker">
        <ProposalDot />
        <span>{`Proposal · ${sourceLabel(head.source)}`}</span>
        <span className="gym-proposal-when">{arrivedLabel(head.createdAt)}</span>
      </p>
      <p className="gym-proposal-line">{summaryLine(head, routine.name)}</p>
      {/* WHAT IT WOULD DO, IN OUR WORDS AND NOT THE AGENT'S. The line above is the agent's own
          summary, and a gently worded one over a removal is exactly the sentence a lifter skims. */}
      {consequence && <p className="gym-proposal-intent">{consequence}</p>}
      <a className="gym-proposal-review" href={proposalHref(head.id)}>{reviewLabel(head)}</a>
    </article>
  );
}

// The dot the card, the routine's row and the history share — one mark for "something is waiting",
// so a lifter who learned it on Today reads it on the routines list without being told again. It is
// exported for the routine's own history section, which draws proposals among the days the routine
// was written on (Routines.jsx): one mark, in one place, whoever draws it.
export function ProposalDot() {
  return <span className="gym-proposal-dot" aria-hidden="true" />;
}

// THE SAME FACT ON THE ROUTINE IT TOUCHES (canon screen 5) — the dot and the count on the row, so a
// lifter who came to the routines list rather than to Today still finds it. It counts to one because
// the ROUTINES READ carries one: `pendingProposal` is a single head, the newest, whichever door
// wrote it. The store's own rule is one pending per (routine, door, connection) — so the day a
// second door or a real connection id lands, this row and the card above it are drawing the newest
// of several, and both need a count the wire does not send yet.
export function ProposalFlag() {
  return (
    <span className="gym-routine-flag">
      <ProposalDot />
      1 proposal
    </span>
  );
}

// THE ROUTINE'S HISTORY MOVED TO THE ROUTINE (Routines.jsx). It was a read of its own here — the
// whole proposal ledger, filtered by routine — and it is now one section of the routine's own read,
// beside the day the routine was created, which is a row this ledger never held and could not.
// Nothing about a proposal is spelled there: `historyLabel` and `isPending` in proposals.js are what
// a row says, so a row on that screen and the card above it stay one object read twice.

// SCREEN 14 — the diff, and the only place in this product where a routine an agent wrote to moves.
// Both verbs are here and neither is anywhere else: no list applies, no card applies, and no tool at
// any grant level can reach this route at all.
export function ProposalDiff({ id, log }) {
  const view = useGymRead(() => gymApi.proposal(id), [id]);
  // What the store answered when this was settled. It replaces the read rather than re-fetching it,
  // exactly as the routine editor holds its draft: the settlement's own reply IS the newer proposal,
  // and asking again for what we were just handed would draw a frame of the old state first.
  const [settled, setSettled] = useState(null);
  const [deciding, setDeciding] = useState(false);

  if (view.phase === 'loading') return <p className="gym-quiet">Opening the proposal…</p>;
  if (view.phase === 'absent') {
    return (
      <>
        <a className="gym-back" href={ROUTINES_HREF}><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Routines</a>
        <p className="gym-quiet">That proposal isn’t in your program.</p>
      </>
    );
  }
  if (view.phase === 'failed') {
    return (
      <>
        <a className="gym-back" href={ROUTINES_HREF}><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Routines</a>
        <p className="gym-read-failed">
          The proposal didn’t load.
          <button type="button" className="gym-retry" onClick={view.retry}>Retry</button>
        </p>
      </>
    );
  }

  const proposal = settled ?? view.data;
  const rows = diffRows(proposal);
  const documentNote = documentLine(proposal);

  // THE TAP, AND THE THREE WAYS THE WORLD CAN HAVE MOVED UNDER IT. Both 409s are terminal and
  // neither is repairable by sending the same request again — the routine changed, or the other
  // decision was already taken — so each one re-reads and says what happened rather than offering a
  // retry that would fail identically forever.
  const settle = async (verb) => {
    if (deciding) return;
    setDeciding(true);
    // A removal that landed took the routine — and the ledger row this screen is drawing — with it,
    // so there is nothing left here to redraw. The store answers that either way: 200 with the
    // settled proposal, or a 404 for the row that cascaded, and both mean the same thing.
    const removed = () => {
      log.say(`${proposal.baseName} was removed.`);
      window.location.hash = ROUTINES_HREF;
    };
    // What the world moving under a diff costs: the answer in hand is dropped and the store is
    // asked again, because whatever happened is what the proposal now says.
    const reread = (sentence) => {
      setSettled(null);
      view.retry();
      log.say(sentence);
    };
    try {
      const answer = verb === 'apply'
        ? await gymApi.applyProposal(proposal.id)
        : await gymApi.dismissProposal(proposal.id);
      if (verb === 'apply' && proposal.intent === 'remove') {
        removed();
        return;
      }
      setSettled(answer.proposal);
    } catch (error) {
      if (verb === 'apply' && proposal.intent === 'remove' && error.status === 404) {
        removed();
        return;
      }
      if (error.proposalSuperseded) reread(`${proposal.baseName} changed after this was written. Nothing from it was applied.`);
      else if (error.proposalSettled) reread('That proposal was already decided somewhere else.');
      else if (error.status === 404) reread('That proposal isn’t in your program any more.');
      else log.say(`That wasn’t ${verb === 'apply' ? 'applied' : 'dismissed'} — ${failureReason(error)}.`);
    }
    setDeciding(false);
  };

  return (
    <>
      <a className="gym-back" href={routineHref(proposal.routineId)}>
        <ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> {proposal.baseName}
      </a>
      <header className="gym-proposal-head">
        <div className="gym-proposal-titles">
          <h1 className="gym-title">{`Proposal · ${proposal.baseName}`}</h1>
          <p className="gym-proposal-from">
            {`from ${sourceLabel(proposal.source)}  ·  ${arrivedLabel(proposal.createdAt)}`}
          </p>
          {/* AND THE CONVERSATION IT WAS ASKED FOR IN (§O), where the wire carried one. Absent means
              there is nothing to open — the MCP door, or a thread the lifter deleted — and neither
              is an apology to print: the line above still names the door the change came through. */}
          {conversationOf(proposal.source) && (
            <a className="gym-proposal-thread" href={threadHref(conversationOf(proposal.source))}>
              {CONVERSATION_VERB} ›
            </a>
          )}
        </div>
        <span className={`gym-proposal-chip is-${proposal.state}`}>{stateChip(proposal)}</span>
      </header>

      <p className="gym-proposal-summary">{summaryLine(proposal, proposal.baseName)}</p>

      {/* THE DOCUMENT IS FROZEN, so the position of a row is part of its identity: a routine may name
          one movement twice — the heavy line and the back-off line — and nothing here ever reorders
          or filters what is drawn. The whole run is drawn for that same reason: a movement that only
          MOVED is an unmarked row in a new place, and it is on this list or it is nowhere. */}
      {documentNote && <p className="gym-diff-caption">{documentNote}</p>}
      <ul className="gym-diff">
        {rows.map((row, index) => (
          <li className={`gym-diff-row is-${row.kind}`} key={`${index}-${row.exerciseId ?? row.kind}`}>
            <DiffRow row={row} catalog={log.catalog} />
          </li>
        ))}
      </ul>

      {!isPending(proposal) && <p className="gym-proposal-settled">{settledLine(proposal)}</p>}

      {isPending(proposal) && (
        <div className="gym-proposal-decide">
          <div className="gym-proposal-verbs">
            <button
              type="button"
              className={deciding ? 'gym-proposal-dismiss is-inert' : 'gym-proposal-dismiss'}
              onClick={() => settle('dismiss')}
            >
              Dismiss
            </button>
            <button
              type="button"
              className={deciding ? 'gym-proposal-apply is-inert' : 'gym-proposal-apply'}
              onClick={() => settle('apply')}
            >
              {applyLabel(proposal)}
            </button>
          </div>
          <p className="gym-proposal-atomic">{atomicLine(proposal)}</p>
        </div>
      )}

      {/* THE SECOND PLACE ASK IS REACHED FROM (§L: Today's band, and a proposal). This is the screen
          where "why?" is the question, and the room that answers it reads the same log the proposal
          was written from. It is a quiet link and never a second verb — the two verbs on this screen
          are the decision, and nothing may compete with them.
          Not while a workout is running: Ask is never offered mid-session, and the server refuses
          one anyway. */}
      {!log.session && <a className="gym-ask-aside" href={ASK_HREF}>Ask about your training ›</a>}

      {/* THE INVITATION (§D12), on the one screen where the thing it promises is already on the
          table: this diff IS the object the pitch describes, and a lifter reading one Ask wrote is
          exactly the person whose own Claude could have written it. It draws nothing for somebody
          already connected — which is every lifter whose agent wrote this proposal — so the card
          lands where it is news and nowhere else. */}
      <ConnectInvitation training={log.session != null} />
    </>
  );
}

// One row of the diff. The movement's name is a door onto its record (§H), here as everywhere else a
// movement is named — and it earns its place twice over on this screen: "should I take heavier
// triples" is a question about where that lift stands, and the page that answers it is one tap away.
// Nothing is held here, so leaving costs a re-read and nothing else.
//
// EXPORTED FOR ASK, which draws a proposal it just minted with this renderer rather than a compact
// copy of it. A second reading of one change would be the product disagreeing with itself about one
// routine on two screens — and Ask's card is the first place a lifter sees that change at all.
export function DiffRow({ row, catalog }) {
  if (row.kind === 'renamed') {
    return (
      <>
        <span className="gym-diff-name">Name</span>
        <span className="gym-diff-moves">
          <Move from={row.from} to={row.to} />
        </span>
      </>
    );
  }

  const name = (
    <a className="gym-diff-name gym-movement-door" href={recordHref(row.exerciseId)}>
      {nameOfMovement(catalog, row.exerciseId)}
    </a>
  );

  // A LINE THIS PROPOSAL DOES NOT TOUCH, drawn anyway and drawn quiet. It carries no mark and no
  // arrow because nothing about its numbers moved — what it carries is its PLACE in the run, which
  // is the one change the change rows can otherwise make without saying anything.
  if (row.kind === 'kept') {
    return (
      <>
        {name}
        <span className="gym-diff-note">{row.targets}</span>
      </>
    );
  }

  if (row.kind === 'added') {
    return (
      <>
        <span className="gym-diff-mark" aria-hidden="true">+</span>
        {name}
        <span className="gym-diff-note">
          {`added · ${row.targets}${row.rest ? ` · rest ${row.rest}` : ''} · ${row.follows ? `after ${nameOfMovement(catalog, row.follows)}` : 'first in the routine'}`}
        </span>
      </>
    );
  }

  if (row.kind === 'removed') {
    return (
      <>
        <span className="gym-diff-mark" aria-hidden="true">−</span>
        {name}
        {/* Your logged sets are never part of a proposal — the routine stops asking for the
            movement and the log keeps every set of it, which is the sentence this row exists for. */}
        <span className="gym-diff-note">
          {`removed from the routine${row.kept ? ` · ${row.kept}` : ''}`}
        </span>
      </>
    );
  }

  return (
    <>
      {name}
      <span className="gym-diff-moves">
        {row.moves.map((move) => (
          <span className="gym-diff-move" key={move.field}>
            <span className="gym-diff-field">{move.field}</span>
            <Move from={move.from} to={move.to} />
          </span>
        ))}
      </span>
    </>
  );
}

// The before struck through and the after in the ink every target on this surface is drawn in, which
// is the whole of what a field-level diff is: two readings of one line, and no arithmetic between
// them.
function Move({ from, to }) {
  return (
    <>
      <span className="gym-diff-was">{from}</span>
      <span className="gym-diff-arrow" aria-hidden="true">→</span>
      <span className="gym-diff-is">{to}</span>
    </>
  );
}
