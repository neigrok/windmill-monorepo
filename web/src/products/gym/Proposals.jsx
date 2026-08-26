import React, { useState } from 'react';
import { Button, Dialog } from '../../design-system/index.js';
import { failureReason, gymApi } from './gymApi.js';
import { arrivedLabel, nameOfMovement, proposalHref, recordHref, threadHref } from './log.js';
import {
  applyLabel, atomicLine, collapseKept, conversationOf, CONVERSATION_VERB, diffRows, documentLine,
  intentLine, isPending, keptRunLabel, MID_WORKOUT_CAVEAT, receiptLine, REVIEW_VERB, settledLine,
  sourceLabel, stateChip, STILL_WAITING, summaryLine, TURN_DOWN_CONFIRM, TURN_DOWN_VERB, wroteKicker,
} from './proposals.js';
import { useGymRead } from './useGymRead.js';

// The standing surface for a proposal with no conversation to appear in — one minted over MCP —
// drawn at the head of the routines home off the list's own read. Review opens the dialog over the
// home; settling says its receipt in the one voice, and `onChanged` re-reads the list whenever the
// dialog settled the proposal or learned it had moved.
export function PendingProposals({ routines, log, onChanged }) {
  const [reviewing, setReviewing] = useState(null);
  const waiting = (routines ?? []).filter((routine) => routine.pendingProposal);
  // The dialog stands outside the cards: a re-read that drops the card it was opened from (the
  // proposal moved underneath it) must not take the dialog and its refusal down with it.
  return (
    <>
      {waiting.length > 0 && (
        <section className="gym-proposals">
          {waiting.map((routine) => (
            <ProposalCard key={routine.id} routine={routine} onReview={setReviewing} />
          ))}
        </section>
      )}
      {reviewing && (
        <ProposalReview
          key={reviewing}
          id={reviewing}
          log={log}
          onClose={() => setReviewing(null)}
          onChanged={onChanged}
          onSettled={(receipt) => {
            setReviewing(null);
            log.say(receiptLine(receipt));
            onChanged();
          }}
        />
      )}
    </>
  );
}

function ProposalCard({ routine, onReview }) {
  const head = routine.pendingProposal;
  const consequence = intentLine(head, routine.name);
  return (
    <article className="gym-proposal-card">
      <p className="gym-proposal-kicker">
        <ProposalDot />
        <span>{`Proposal · ${sourceLabel(head.source)}`}</span>
        <span className="gym-proposal-when">{`${STILL_WAITING} · ${arrivedLabel(head.createdAt)}`}</span>
      </p>
      <p className="gym-proposal-line">{summaryLine(head, routine.name)}</p>
      {consequence && <p className="gym-proposal-intent">{consequence}</p>}
      <ReviewDoor head={head} onReview={onReview} />
    </article>
  );
}

// The card's one affordance. A link, so the routable address survives a middle-click; a tap opens
// the dialog in place with no hash change.
export function ReviewDoor({ head, onReview }) {
  return (
    <a
      className="gym-proposal-review"
      href={proposalHref(head.id)}
      onClick={(event) => { event.preventDefault(); onReview(head.id); }}
    >
      {REVIEW_VERB}
    </a>
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

// The review: a dialog over whatever opened it. Closing it decides nothing. The band holds Apply,
// gated until the diff has been seen to its end, and the plain text row beneath it turns the
// proposal down behind its confirmation. `onSettled` receives `{ verb, proposal }` off the server's
// reply, which is what the receipt is derived from. `onChanged` fires when a refusal taught the dialog
// the proposal had moved underneath it, so the card behind it never outlives what it just learned.
export function ProposalReview({ id, log, onClose, onSettled, onChanged = null }) {
  const view = useGymRead(() => gymApi.proposal(id), [id]);
  // A refused settle re-reads; the re-read replaces the first.
  const [settled, setSettled] = useState(null);
  const [deciding, setDeciding] = useState(false);
  const [turningDown, setTurningDown] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const [refusal, setRefusal] = useState('');

  const proposal = settled ?? (view.phase === 'ready' ? view.data : null);
  const pending = proposal ? isPending(proposal) : false;
  const midWorkout = Boolean(log.session) && pending;
  // Position is part of a row's identity: never reorder or filter these rows; a kept run folds in place.
  const rows = proposal ? collapseKept(diffRows(proposal), expanded) : [];
  const documentNote = proposal ? documentLine(proposal) : null;
  const wrote = (proposal?.summary ?? '').trim();

  const settle = async (verb) => {
    if (deciding || !proposal) return;
    setDeciding(true);
    setRefusal('');
    const reread = (sentence) => {
      setSettled(null);
      view.retry();
      onChanged?.();
      setRefusal(sentence);
    };
    try {
      const answer = verb === 'apply'
        ? await gymApi.applyProposal(proposal.id)
        : await gymApi.dismissProposal(proposal.id);
      onSettled({ verb, proposal: answer.proposal ?? proposal });
      return;
    } catch (error) {
      // On an applied removal a 404 means the same as success: the routine and its ledger went.
      if (verb === 'apply' && proposal.intent === 'remove' && error.status === 404) {
        onSettled({ verb, proposal });
        return;
      }
      // The server's sentence where it sent one; the room's words only for a reply that carried none.
      const said = typeof error.detail === 'string' && error.detail !== '' ? error.detail : null;
      if (error.proposalSuperseded) reread(said ?? `${proposal.baseName} changed after this was written. Nothing from it was applied.`);
      else if (error.proposalSettled) reread(said ?? 'That proposal was already decided somewhere else.');
      else if (error.status === 404) reread(said ?? 'That proposal isn’t in your program any more.');
      else setRefusal(said ?? `That wasn’t ${verb === 'apply' ? 'applied' : 'turned down'} — ${failureReason(error)}.`);
    }
    setDeciding(false);
    setTurningDown(false);
  };

  const band = ({ seen }) => {
    if (turningDown) {
      return (
        <section className="gym-confirm gym-proposal-confirm">
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
      );
    }
    return (
      <div className="gym-proposal-band">
        <button
          type="button"
          className={!seen || deciding ? 'gym-proposal-apply is-inert' : 'gym-proposal-apply'}
          disabled={!seen || deciding}
          aria-busy={deciding}
          onClick={() => settle('apply')}
        >
          {applyLabel(proposal)}
        </button>
        <button type="button" className="gym-proposal-turn-down" onClick={() => setTurningDown(true)}>
          {TURN_DOWN_VERB}
        </button>
      </div>
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={proposal ? `Proposal · ${proposal.baseName}` : 'Proposal'}
      width={560}
      padding="var(--space-5)"
      gate="scrolled"
      footer={pending ? band : null}
    >
      <div className="gym-proposal-dialog">
        {view.phase === 'loading' && !settled && <p className="gym-quiet">Opening the proposal…</p>}
        {view.phase === 'absent' && !settled && <p className="gym-quiet">That proposal isn’t in your program.</p>}
        {view.phase === 'failed' && !settled && (
          <p className="gym-read-failed">
            The proposal didn’t load.
            <Button variant="secondary" size="sm" onClick={view.retry}>Retry</Button>
          </p>
        )}
        {proposal && (
          <>
            <header className="gym-proposal-head">
              <div className="gym-proposal-titles">
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

            {midWorkout && <p className="gym-proposal-caveat">{MID_WORKOUT_CAVEAT}</p>}

            {/* The writer's own words, attributed and apart from the counted rows. With none, the card's
                own sentence stands as ours. */}
            {wrote !== '' ? (
              <blockquote className="gym-proposal-wrote">
                <p className="gym-proposal-wrote-kicker">{wroteKicker(proposal.source)}</p>
                <p className="gym-proposal-wrote-text">{wrote}</p>
              </blockquote>
            ) : (
              <p className="gym-proposal-summary">{summaryLine(proposal, proposal.baseName)}</p>
            )}

            {documentNote && <p className="gym-diff-caption">{documentNote}</p>}
            <ul className="gym-diff">
              {rows.map((row, index) => (
                row.kind === 'kept-run' ? (
                  <li className="gym-diff-row is-kept-run" key={`run-${row.at}`}>
                    <button type="button" className="gym-diff-unfold" onClick={() => setExpanded((held) => new Set([...held, row.at]))}>
                      {keptRunLabel(row.rows.length)}
                    </button>
                  </li>
                ) : (
                  <li className={`gym-diff-row is-${row.kind}`} key={`${index}-${row.exerciseId ?? row.kind}`}>
                    <DiffRow row={row} catalog={log.catalog} />
                  </li>
                )
              ))}
            </ul>

            {pending && <p className="gym-proposal-atomic">{atomicLine(proposal)}</p>}
            {!pending && <p className="gym-proposal-settled">{settledLine(proposal)}</p>}
          </>
        )}
        {refusal && <p className="gym-proposal-refusal">{refusal}</p>}
      </div>
    </Dialog>
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
