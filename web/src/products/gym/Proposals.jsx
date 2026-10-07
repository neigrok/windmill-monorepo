import React, { useEffect, useState } from 'react';
import { Button } from '../../design-system/index.js';
import { failureReason } from './errors.js';
import { arrivedLabel, nameOfMovement, proposalHref, recordHref, threadHref } from './log.js';
import {
  atomicLine, collapseKept, conversationOf, CONVERSATION_VERB, countedLabel, diffRows,
  isPending, keptRunLabel, MID_WORKOUT_CAVEAT, receiptLine,
  sourceLabel, stateChip, summaryLine, TURN_DOWN_VERB,
} from './proposals.js';
import { useGymRead } from './useGymRead.js';
import { useGymApi } from './gymRuntime.js';
import './coach/coach.css';

export function ProposalPreview({ routine, onExpand, log }) {
  const api = useGymApi();
  const id = routine.pendingProposal.id;
  const view = useGymRead(() => api.proposal(id), [id], { sync: true, ready: Boolean(api?.ready) });
  const changed = view.data ? diffRows(view.data).filter((row) => row.kind !== 'kept') : [];
  return <section className="gym-routine-review" aria-label={`Pending change to ${routine.name}`}>
    <header><span className="gym-proposal-name">{countedLabel(routine.pendingProposal)}</span><a className="gym-proposal-review" href={proposalHref(id)} onClick={(event) => { event.preventDefault(); onExpand(id); }}>Review</a></header>
    {changed.length ? <ul className="gym-diff">{changed.slice(0, 3).map((row, index) => <li className={`gym-diff-row is-${row.kind}`} key={index}><DiffRow row={row} catalog={log.catalog} /></li>)}</ul> : <p className="gym-proposal-line">{summaryLine(routine.pendingProposal, routine.name)}</p>}
    {changed.length > 3 && <p className="gym-share-meta">{changed.length - 3} more changes</p>}
  </section>;
}

export function ProposalPanel({ id, log, onChanged = null, onSettled = null, inConversation = false }) {
  const api = useGymApi();
  const view = useGymRead(() => api.proposal(id), [id], { sync: true, ready: Boolean(api?.ready) });
  const [settled, setSettled] = useState(null);
  useEffect(() => setSettled(null), [view.data]);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const [refusal, setRefusal] = useState('');
  const [receiptNode, setReceiptNode] = useState(null);
  const proposal = settled ?? (view.phase === 'ready' ? view.data : null);
  const pending = proposal ? isPending(proposal) : false;
  const waitingRemoval = proposal?.removalOutcome === 'pending';
  const rows = proposal ? collapseKept(diffRows(proposal), expanded) : [];

  useEffect(() => {
    if (!receiptNode || !proposal?.removalOutcome || waitingRemoval) return;
    let visible = false;
    let showing = false;
    const shown = () => {
      if (!visible || document.visibilityState !== 'visible' || showing) return;
      showing = true;
      api.removalReceiptShown(id, proposal.removalOwner, proposal.removalOutcome).catch(() => { showing = false; });
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; shown(); });
    observer.observe(receiptNode);
    document.addEventListener('visibilitychange', shown);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', shown); };
  }, [api, id, receiptNode, proposal?.removalOutcome, proposal?.removalOwner, waitingRemoval]);

  const decide = async (verb) => {
    if (busy || !pending || waitingRemoval) return;
    setBusy(true);
    setRefusal('');
    try {
      const answer = verb === 'apply' ? await api.applyProposal(id) : await api.dismissProposal(id);
      const stored = answer?.proposal ?? proposal;
      setSettled(stored);
      onSettled?.({ verb, proposal: stored });
      onChanged?.();
    } catch (error) {
      if (['proposal-superseded', 'proposal-settled', 'unknown-record', 'record-dead'].includes(error.code)) {
        view.refresh();
        onChanged?.();
      }
      setRefusal(error.sentence || `That wasn’t ${verb === 'apply' ? 'applied' : 'turned down'} — ${failureReason(error)}.`);
    } finally {
      setBusy(false);
    }
  };

  if (!proposal) return <article className="gym-coach-proposal">
    <p>{view.phase === 'loading' ? 'Opening the proposal…' : view.phase === 'absent' ? 'That proposal isn’t in your program.' : 'The proposal didn’t load.'}</p>
    {view.phase === 'failed' && <Button variant="secondary" onClick={view.retry}>Retry</Button>}
    {refusal && <p role="alert">{refusal}</p>}
  </article>;

  return <article className={`gym-coach-proposal gym-proposal-inline is-${proposal.state}`}>
    <p className="gym-proposal-kicker">{proposal.baseName && <span className="gym-proposal-name">{proposal.baseName}</span>}<span>{`${proposal.baseName ? ' · ' : ''}${countedLabel(proposal)}`}</span></p>
    {proposal.source?.door !== 'ask' && <p className="gym-proposal-from">{`from ${sourceLabel(proposal.source)} · ${arrivedLabel(proposal.createdAt)}`}</p>}
    {!inConversation && conversationOf(proposal.source) && <a className="gym-proposal-thread" href={threadHref(conversationOf(proposal.source))}>{CONVERSATION_VERB}</a>}
    {log.session && pending && <p className="gym-proposal-caveat">{MID_WORKOUT_CAVEAT}</p>}
    <ul className="gym-diff">{rows.map((row, index) => row.kind === 'kept-run'
      ? <li className="gym-diff-row is-kept-run" key={`run-${row.at}`}><button className="gym-diff-unfold" type="button" onClick={() => setExpanded((held) => new Set([...held, row.at]))}>{keptRunLabel(row.rows.length)} ›</button></li>
      : <li className={`gym-diff-row is-${row.kind}`} key={`${index}-${row.exerciseId ?? row.kind}`}><DiffRow row={row} catalog={log.catalog} unfold /></li>)}</ul>
    {waitingRemoval ? <p className="gym-coach-receipt" role="status">Removal waiting to sync.</p> : pending ? <div className="gym-proposal-band">
      <Button disabled={busy} onClick={() => decide('apply')}>{busy ? 'Saving…' : 'Apply'}</Button>
      <p className="gym-proposal-atomic">{proposal.intent === 'revise' ? 'Logged sets stay unchanged.' : atomicLine(proposal)}</p>
      <button type="button" className="gym-proposal-turn-down" disabled={busy} onClick={() => decide('dismiss')}>{TURN_DOWN_VERB}</button>
    </div> : <p className="gym-coach-receipt" role="status" ref={setReceiptNode}>{proposal.state === 'applied'
      ? receiptLine({ verb: 'apply', proposal }) : proposal.state === 'dismissed'
        ? receiptLine({ verb: 'dismiss', proposal }) : `${stateChip(proposal)} · nothing applied.`}</p>}
    {(refusal || proposal.removalRefusal) && <p className="gym-proposal-refusal" role="alert"
      ref={proposal.removalOutcome === 'refused' ? setReceiptNode : null}>{refusal || proposal.removalRefusal}</p>}
  </article>;
}

export function DiffRow({ row, catalog, unfold = false }) {
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
            <span className="gym-diff-field">{move.field === 'sets' ? '' : move.field}</span>
            <Move from={move.from} to={move.to} compact={move.field === 'sets'} />
          </span>
        ))}
      </span>
      {unfold && row.moves.filter((move) => move.ladder && (new Set(move.ladder.from).size > 1 || new Set(move.ladder.to).size > 1)).map((move) => (
        <SchemeUnfold key={move.field} ladder={move.ladder} />
      ))}
    </>
  );
}

export const UNFOLD_LADDER = 'set by set';

function SchemeUnfold({ ladder }) {
  const [unfolded, setUnfolded] = useState(false);
  const count = Math.max(ladder.from.length, ladder.to.length);
  return (
    <>
      <button type="button" className="gym-diff-unfold" aria-expanded={unfolded} onClick={() => setUnfolded((held) => !held)}>
        {UNFOLD_LADDER}
      </button>
      {unfolded && (
        <ul className="gym-diff-ladder">
          {Array.from({ length: count }, (_, index) => (
            <li className="gym-diff-ladder-row" key={index}>
              <span className="gym-diff-ladder-ordinal">{index + 1}</span>
              <Move from={ladder.from[index] ?? '—'} to={ladder.to[index] ?? '—'} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Move({ from, to, compact = false }) {
  const prefix = from.lastIndexOf(' · ');
  const after = compact && prefix > 0 && from.slice(0, prefix) === to.slice(0, prefix) ? to.slice(prefix + 3) : to;
  return (
    <>
      <span className="gym-diff-was">{from}</span>
      <span className="gym-diff-arrow" aria-hidden="true">→</span>
      <span className="gym-diff-is">{after}</span>
    </>
  );
}
