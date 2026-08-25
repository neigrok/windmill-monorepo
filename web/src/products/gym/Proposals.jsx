import React, { useState } from 'react';
import { Back } from './Back.jsx';
import { failureReason, gymApi } from './gymApi.js';
import {
  arrivedLabel, COACH_HREF, nameOfMovement, proposalHref, recordHref, routineHref, ROUTINES_HREF,
  threadHref,
} from './log.js';
import {
  applyLabel, atomicLine, conversationOf, CONVERSATION_VERB, diffRows, documentLine, intentLine,
  isPending, reviewLabel, settledLine, sourceLabel, stateChip, summaryLine, TURN_DOWN_CONFIRM,
} from './proposals.js';
import { useGymRead } from './useGymRead.js';

// The standing surface for a proposal with no conversation to appear in — one minted over MCP —
// drawn at the head of the routines home off the list's own read.
export function PendingProposals({ routines }) {
  const waiting = (routines ?? []).filter((routine) => routine.pendingProposal);
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
      {consequence && <p className="gym-proposal-intent">{consequence}</p>}
      <a className="gym-proposal-review" href={proposalHref(head.id)}>{reviewLabel(head)}</a>
    </article>
  );
}

export function ProposalDot() {
  return <span className="gym-proposal-dot" aria-hidden="true" />;
}

export function ProposalFlag() {
  return (
    <span className="gym-routine-flag">
      <ProposalDot />
      proposal pending
    </span>
  );
}

export function ProposalDiff({ id, log }) {
  const view = useGymRead(() => gymApi.proposal(id), [id]);
  // The settle reply carries the newer proposal; it replaces the read.
  const [settled, setSettled] = useState(null);
  const [deciding, setDeciding] = useState(false);
  const [turningDown, setTurningDown] = useState(false);

  if (view.phase === 'loading') return <p className="gym-quiet">Opening the proposal…</p>;
  if (view.phase === 'absent') {
    return (
      <>
        <Back href={ROUTINES_HREF}>Routines</Back>
        <p className="gym-quiet">That proposal isn’t in your program.</p>
      </>
    );
  }
  if (view.phase === 'failed') {
    return (
      <>
        <Back href={ROUTINES_HREF}>Routines</Back>
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

  const settle = async (verb) => {
    if (deciding) return;
    setDeciding(true);
    // On an applied removal a 404 means the same as success.
    const removed = () => {
      log.say(`${proposal.baseName} was removed.`);
      window.location.hash = ROUTINES_HREF;
    };
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
      else log.say(`That wasn’t ${verb === 'apply' ? 'applied' : 'turned down'} — ${failureReason(error)}.`);
    }
    setDeciding(false);
    setTurningDown(false);
  };

  return (
    <>
      <Back href={routineHref(proposal.routineId)}>{proposal.baseName}</Back>
      <header className="gym-proposal-head">
        <div className="gym-proposal-titles">
          <h1 className="gym-title">{`Proposal · ${proposal.baseName}`}</h1>
          <p className="gym-proposal-from">
            {`from ${sourceLabel(proposal.source)}  ·  ${arrivedLabel(proposal.createdAt)}`}
          </p>
          {conversationOf(proposal.source) && (
            <a className="gym-proposal-thread" href={threadHref(conversationOf(proposal.source))}>
              {CONVERSATION_VERB} ›
            </a>
          )}
        </div>
        <span className={`gym-proposal-chip is-${proposal.state}`}>{stateChip(proposal)}</span>
      </header>

      <p className="gym-proposal-summary">{summaryLine(proposal, proposal.baseName)}</p>

      {/* Position is part of a row's identity: never reorder or filter these rows. */}
      {documentNote && <p className="gym-diff-caption">{documentNote}</p>}
      <ul className="gym-diff">
        {rows.map((row, index) => (
          <li className={`gym-diff-row is-${row.kind}`} key={`${index}-${row.exerciseId ?? row.kind}`}>
            <DiffRow row={row} catalog={log.catalog} />
          </li>
        ))}
      </ul>

      {!isPending(proposal) && <p className="gym-proposal-settled">{settledLine(proposal)}</p>}

      {isPending(proposal) && !turningDown && (
        <div className="gym-proposal-decide">
          <div className="gym-proposal-verbs">
            <button
              type="button"
              className={deciding ? 'gym-proposal-dismiss is-inert' : 'gym-proposal-dismiss'}
              onClick={() => setTurningDown(true)}
            >
              Turn this down
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

      {/* Turning down is settled for good, so it is confirmed; the confirmation says so. */}
      {isPending(proposal) && turningDown && (
        <section className="gym-confirm">
          <p className="gym-confirm-title">{TURN_DOWN_CONFIRM.title}</p>
          <p className="gym-confirm-body">{TURN_DOWN_CONFIRM.body}</p>
          <div className="gym-finish-foot">
            <button type="button" className="gym-confirm-keep" onClick={() => setTurningDown(false)}>{TURN_DOWN_CONFIRM.keep}</button>
            <button
              type="button"
              className={deciding ? 'gym-confirm-do is-inert' : 'gym-confirm-do'}
              onClick={() => settle('dismiss')}
            >
              {TURN_DOWN_CONFIRM.confirm}
            </button>
          </div>
        </section>
      )}

      {!log.session && <a className="gym-coach-aside" href={COACH_HREF}>Open Coach ›</a>}
    </>
  );
}

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

  if (row.kind === 'reordered') {
    return (
      <>
        <span className="gym-diff-name">Order</span>
        <span className="gym-diff-note">the lines run in the order below</span>
      </>
    );
  }

  const name = (
    <a className="gym-diff-name gym-movement-door" href={recordHref(row.exerciseId)}>
      {nameOfMovement(catalog, row.exerciseId)}
    </a>
  );

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

function Move({ from, to }) {
  return (
    <>
      <span className="gym-diff-was">{from}</span>
      <span className="gym-diff-arrow" aria-hidden="true">→</span>
      <span className="gym-diff-is">{to}</span>
    </>
  );
}
