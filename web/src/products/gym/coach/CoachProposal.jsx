import React, { useState } from 'react';
import { AlertCircle, ArrowLeftRight, ChevronRight, CircleCheck, CircleSlash, List, Minus, Pencil, Plus } from 'lucide-react';
import { Id } from '../../../platform/domain-kit/entities.js';
import { Catalogue } from '../domain/catalogue.js';
import { Proposal, ProposalState } from '../domain/proposals.js';
import { ProposalDiff } from '../domain/proposalDiff.js';
import { Routine } from '../domain/routines.js';
import { GymUnits } from '../domain/units.js';
import { failureReason } from '../errors.js';
import { useGymApi } from '../gymRuntime.js';
import { t } from '../i18n/index.js';
import { nameOfMovement } from '../log.js';
import { weightUnit } from '../units.js';
import { useDomainRead } from '../useDomainRead.js';

const SHOWN = 2;
const KIND_ICONS = { renamed: Pencil, moved: ArrowLeftRight, changed: Pencil, removed: Minus, added: Plus };

// A proposal as its card reads it (08.2P in web form): the shared `ProposalDiff`'s blocks against the routine, its name,
// and whether Apply would still be taken.
function proposalCard(read, record) {
  const proposal = read.repository(Proposal).find(new Id(record, Proposal), 'drawn');
  if (proposal === null) return null;
  const routine = read.repository(Routine).find(proposal.routineId, 'drawn');
  const catalogue = new Catalogue(read);
  const each = proposal.changes.map((change) => change.exerciseId)
    .filter((id) => { const movement = catalogue.find(id); return movement?.equipment === 'dumbbell' && movement.loadCount === 2; });
  return { diff: new ProposalDiff(proposal, routine, GymUnits.reading(weightUnit()), each), state: proposal.state,
    name: proposal.baseName ?? routine?.name ?? proposal.proposedName ?? '', outOfDate: ProposalState.of(read, proposal.id).outOfDate === true };
}

// One line of a block: its label, the old value struck through and the new one, or the one side a new or gone line has.
function FieldLine({ field }) {
  return <p className="gym-coach-proposal-line">
    <span>{field.label}</span>
    <span>
      {field.before !== null && <s>{field.before}</s>}
      {field.before !== null && field.after !== null && <ChevronRight size={14} aria-hidden="true" />}
      {field.after !== null && <strong>{field.after}</strong>}
    </span>
  </p>;
}

// A routine proposal under the answer whose call made it (08W.25–08W.28): pending with Reject and Apply, applied,
// rejected, or out of date. Apply and Reject are the lifter's gestures and the server's commands; no ability decides one.
export function CoachProposalCard({ id, movements }) {
  const api = useGymApi();
  const card = useDomainRead((read) => proposalCard(read, id), [id]).data;
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState('');
  const [open, setOpen] = useState(false);
  if (!card) return null;
  const { diff, name, state } = card;
  if (state === 'dismissed') {
    return <p className="gym-coach-proposal-rejected"><CircleSlash size={18} aria-hidden="true" />{t('gym.coach.proposal.rejected', { name })}</p>;
  }
  const applied = state === 'applied';
  const pending = state === 'pending' && !card.outOfDate;
  const outOfDate = !applied && !pending;
  const decide = async (verb) => {
    if (busy) return;
    setBusy(verb);
    setFailure('');
    try {
      if (verb === 'apply') await api.applyProposal(id);
      else await api.dismissProposal(id);
    } catch (error) {
      setFailure(error.sentence || t('gym.proposals.notDecided', { verb, reason: failureReason(error) }));
    } finally {
      setBusy(null);
    }
  };
  const blocks = open ? diff.blocks : diff.blocks.slice(0, SHOWN);
  const Symbol = applied ? CircleCheck : outOfDate ? AlertCircle : List;
  return <section className={`gym-coach-proposal-card${outOfDate ? ' is-out-of-date' : ''}`} aria-label={name}>
    <header>
      <Symbol size={22} aria-hidden="true" className={outOfDate ? undefined : 'gym-coach-made-check'} />
      <span>
        <strong>{applied ? t('gym.coach.proposal.applied', { name }) : outOfDate ? t('gym.coach.proposal.outOfDate', { name }) : name}</strong>
        {outOfDate ? t('gym.coach.proposal.outOfDateLine', { name })
          : applied ? t('gym.coach.proposal.changes', { count: diff.blocks.length }) : t('gym.coach.proposal.suggested', { count: diff.blocks.length })}
      </span>
    </header>
    <ul className="gym-coach-proposal-blocks">{blocks.map((block, index) => {
      const Icon = KIND_ICONS[block.kind];
      return <li key={index} className={`gym-coach-proposal-block is-${block.kind}`}>
        <p className="gym-coach-proposal-movement"><Icon size={18} aria-hidden="true" />
          <span>{block.exerciseId === null ? name : nameOfMovement(movements, block.exerciseId.record)}</span></p>
        {block.fields.map((field, line) => <FieldLine key={line} field={field} />)}
      </li>;
    })}</ul>
    {!open && diff.blocks.length > SHOWN && <button type="button" className="gym-coach-proposal-more" aria-expanded="false" onClick={() => setOpen(true)}>
      {t('gym.coach.proposal.more', { count: diff.blocks.length - SHOWN })}<ChevronRight size={18} aria-hidden="true" /></button>}
    {failure && <p className="gym-coach-proposal-failure" role="alert">{failure}</p>}
    {pending && <div className="gym-coach-proposal-decide">
      <button type="button" className="gym-coach-proposal-reject" disabled={Boolean(busy)} onClick={() => decide('dismiss')}>{t('gym.coach.proposal.reject')}</button>
      <button type="button" className="gym-coach-proposal-apply" disabled={Boolean(busy)} onClick={() => decide('apply')}>
        {busy === 'apply' ? t('gym.coach.proposal.applying') : failure ? t('gym.coach.access.tryAgain') : t('gym.coach.proposal.apply')}</button>
    </div>}
  </section>;
}
