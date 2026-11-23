import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeftRight, CircleCheck, CircleSlash, List, Minus, Pencil, Plus } from 'lucide-react';
import { failureReason } from '../errors.js';
import { useGymApi } from '../gymRuntime.js';
import { t } from '../i18n/index.js';
import { nameOfMovement, recordHref } from '../log.js';
import { diffRows } from '../proposals.js';
import { useGymRead } from '../useGymRead.js';

const SHOWN = 2;
const KIND_ICONS = { renamed: Pencil, reordered: ArrowLeftRight, retargeted: Pencil, added: Plus, removed: Minus };

// One changed block of the card: what changed, with a line per field, old struck through and the new value beside it.
function Block({ row, catalog }) {
  const Icon = KIND_ICONS[row.kind] ?? Pencil;
  const title = row.kind === 'renamed' ? t('gym.proposals.diffName') : row.kind === 'reordered' ? t('gym.proposals.diffOrder')
    : nameOfMovement(catalog, row.exerciseId);
  const lines = row.kind === 'renamed' ? [{ field: '', from: row.from, to: row.to }]
    : row.kind === 'retargeted' ? row.moves : [];
  const note = row.kind === 'reordered' ? t('gym.proposals.reorderedNote') : row.kind === 'added' ? row.targets
    : row.kind === 'removed' ? row.kept ?? t('gym.proposals.removed') : null;
  return <li className={`gym-coach-proposal-block is-${row.kind}`}>
    <p className="gym-coach-proposal-movement"><Icon size={18} aria-hidden="true" />
      {row.exerciseId ? <a href={recordHref(row.exerciseId)}>{title}</a> : <span>{title}</span>}</p>
    {note && <p className="gym-coach-proposal-note">{note}</p>}
    {lines.map((line, index) => <p key={index} className="gym-coach-proposal-line">
      <span>{line.field}</span>
      <span><s>{line.from}</s><span aria-hidden="true"> › </span><strong>{line.to}</strong></span>
    </p>)}
  </li>;
}

// A routine proposal under the answer whose call made it (08W.25–08W.28): pending with Reject and Apply, applied,
// rejected, or out of date. Apply and Reject are the lifter's gestures and the server's commands; no ability decides one.
export function CoachProposalCard({ id, movements }) {
  const api = useGymApi();
  const view = useGymRead(() => api.proposal(id), [id], { sync: true, ready: Boolean(api?.ready) });
  const [settled, setSettled] = useState(null);
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => setSettled(null), [view.data]);
  const proposal = settled ?? (view.phase === 'ready' ? view.data : null);
  if (!proposal) return null;
  const name = proposal.baseName ?? proposal.name ?? '';
  const rows = diffRows(proposal).filter((row) => row.kind !== 'kept');
  const count = proposal.changeCount ?? rows.length;
  if (proposal.state === 'dismissed') {
    return <p className="gym-coach-proposal-rejected"><CircleSlash size={18} aria-hidden="true" />{t('gym.coach.proposal.rejected', { name })}</p>;
  }
  const pending = proposal.state === 'pending' && proposal.outOfDate !== true;
  const outOfDate = proposal.state !== 'applied' && !pending;
  const decide = async (verb) => {
    if (busy) return;
    setBusy(verb);
    setFailure('');
    try {
      const answer = verb === 'apply' ? await api.applyProposal(id) : await api.dismissProposal(id);
      setSettled(answer?.proposal ?? proposal);
    } catch (error) {
      if (['proposal-superseded', 'proposal-settled', 'unknown-record', 'record-dead'].includes(error.code)) view.refresh();
      setFailure(error.sentence || t('gym.proposals.notDecided', { verb, reason: failureReason(error) }));
    } finally {
      setBusy(null);
    }
  };
  const shown = open ? rows : rows.slice(0, SHOWN);
  return <section className={`gym-coach-proposal-card${outOfDate ? ' is-out-of-date' : ''}`} aria-label={name}>
    <header>
      {proposal.state === 'applied' ? <CircleCheck size={22} aria-hidden="true" className="gym-coach-made-check" />
        : outOfDate ? <AlertCircle size={22} aria-hidden="true" /> : <List size={22} aria-hidden="true" className="gym-coach-made-check" />}
      <span>
        <strong>{proposal.state === 'applied' ? t('gym.coach.proposal.applied', { name }) : outOfDate ? t('gym.coach.proposal.outOfDate', { name }) : name}</strong>
        {outOfDate ? t('gym.coach.proposal.outOfDateLine', { name })
          : proposal.state === 'applied' ? t('gym.coach.proposal.changes', { count }) : t('gym.coach.proposal.suggested', { count })}
      </span>
    </header>
    <ul className="gym-coach-proposal-blocks">{shown.map((row, index) => <Block key={index} row={row} catalog={movements} />)}</ul>
    {!open && rows.length > SHOWN && <button type="button" className="gym-coach-proposal-more" onClick={() => setOpen(true)}>
      {t('gym.coach.proposal.more', { count: rows.length - SHOWN })}<span aria-hidden="true"> ›</span></button>}
    {failure && <p className="gym-coach-proposal-failure" role="alert">{failure}</p>}
    {pending && <div className="gym-coach-proposal-decide">
      <button type="button" className="gym-coach-proposal-reject" disabled={Boolean(busy)} onClick={() => decide('dismiss')}>{t('gym.coach.proposal.reject')}</button>
      <button type="button" className="gym-coach-proposal-apply" disabled={Boolean(busy)} onClick={() => decide('apply')}>
        {busy === 'apply' ? t('gym.coach.proposal.applying') : failure ? t('gym.coach.access.tryAgain') : t('gym.coach.proposal.apply')}</button>
    </div>}
  </section>;
}
