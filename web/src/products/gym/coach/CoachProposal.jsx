import React, { useContext, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeftRight, Check, ChevronRight, CircleCheck, CircleSlash, ClipboardList, List, Minus, Pencil, Plus } from 'lucide-react';
import { Button } from '../../../design-system/index.js';
import { Id } from '../../../platform/domain-kit/entities.js';
import { useSyncRecords } from '../../../platform/sync/react.js';
import { Catalogue } from '../domain/catalogue.js';
import { Proposal, ProposalState } from '../domain/proposals.js';
import { ProposalDiff } from '../domain/proposalDiff.js';
import { Routine } from '../domain/routines.js';
import { Session } from '../domain/training.js';
import { TrainingLog } from '../domain/trainingReads.js';
import { GymUnits } from '../domain/units.js';
import { WorkoutProposal, WorkoutProposalState } from '../domain/workoutProposals.js';
import { failureReason } from '../errors.js';
import { decisionRefusal, refusedDecision, useGymApi } from '../gymRuntime.js';
import { t } from '../i18n/index.js';
import { nameOfMovement } from '../log.js';
import { weightUnit } from '../units.js';
import { useDomainRead } from '../useDomainRead.js';
import { CoachForm } from './coach.js';

const SHOWN = 2;
const KIND_ICONS = { renamed: Pencil, moved: ArrowLeftRight, changed: Pencil, removed: Minus, added: Plus };

// The movements of a proposal's lines loaded as a pair of dumbbells, whose loads a card says per hand.
function pairs(read, changes) {
  const catalogue = new Catalogue(read);
  return changes.map((change) => change.exerciseId)
    .filter((id) => { const movement = catalogue.find(id); return movement?.equipment === 'dumbbell' && movement.loadCount === 2; });
}

// A routine proposal as its card reads it (08.2P in web form): the shared `ProposalDiff`'s blocks against the routine, its
// name, whether Apply would still be taken, and whether a workout is open, so the routine waits for its next one (08.56P).
function routineCard(read, record) {
  const proposal = read.repository(Proposal).find(new Id(record, Proposal), 'drawn');
  if (proposal === null) return null;
  const routine = read.repository(Routine).find(proposal.routineId, 'drawn');
  return { diff: ProposalDiff.ofRoutine(proposal, routine, GymUnits.reading(weightUnit()), pairs(read, proposal.changes)), state: proposal.state,
    name: proposal.baseName ?? routine?.name ?? proposal.proposedName ?? '', outOfDate: ProposalState.of(read, proposal.id).outOfDate === true,
    nextTime: new TrainingLog(read).open !== null };
}

// Coach's change to the open workout as its card reads it from the copy (WD7): its blocks against the workout's plan, how
// many changes it suggests, and why it can no longer be applied when it cannot: the domain's reading of the copy, or else
// the log's refusal of a decision on it, which stands among the copy's notices.
function workoutCard(read, record, notices) {
  const proposal = read.repository(WorkoutProposal).find(new Id(record, WorkoutProposal), 'drawn');
  if (proposal === null) return null;
  const plan = read.repository(Session).find(proposal.sessionId, 'stored')?.plan ?? null;
  const refused = refusedDecision(notices, 'workout', record);
  return { diff: ProposalDiff.ofWorkout(proposal, plan, GymUnits.reading(weightUnit()), pairs(read, proposal.changes)), state: proposal.state,
    count: proposal.countChanges(plan?.entries ?? []), stale: WorkoutProposalState.of(read, proposal.id).outOfDate
      ?? (refused && decisionRefusal(refused.code, refused.detail)) };
}

// One line of a block, as the boards draw it: what changes, the old value struck through and the new one; a new or a gone
// line, its one side.
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

// A card's changes: one block per changed movement, its lines that change, two blocks until the disclosure opens the rest in
// place (08.27P). A line whose two sides read the same is left out.
function Changes({ diff, movements, name }) {
  const [open, setOpen] = useState(false);
  const blocks = open ? diff.blocks : diff.blocks.slice(0, SHOWN);
  return <>
    <ul className="gym-coach-proposal-blocks">{blocks.map((block, index) => {
      const Icon = KIND_ICONS[block.kind];
      return <li key={index} className={`gym-coach-proposal-block is-${block.kind}`}>
        <p className="gym-coach-proposal-movement"><Icon size={18} aria-hidden="true" />
          <span>{block.exerciseId === null ? name : nameOfMovement(movements, block.exerciseId.record)}</span></p>
        {block.fields.filter((field) => field.state !== 'same').map((field, line) => <FieldLine key={line} field={field} />)}
      </li>;
    })}</ul>
    {!open && diff.blocks.length > SHOWN && <button type="button" className="gym-coach-proposal-more" aria-expanded="false" onClick={() => setOpen(true)}>
      {t('gym.coach.proposal.more', { count: diff.blocks.length - SHOWN })}<ChevronRight size={18} aria-hidden="true" /></button>}
  </>;
}

// A card's decision while it runs (08W.26's decided states): which is on its way, *Applying…* with Reject held, and why
// the last one did not land, said under the card with Apply reading *Try again*. Once one lands, the line it settles the
// card on takes the focus (`settled`), so a keyboard is not left on a button that is gone.
function useDecision(run) {
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState('');
  const settled = useRef(null);
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    if (!landed || !settled.current) return;
    settled.current.focus();
    setLanded(false);
  });
  const decide = async (verb) => {
    if (busy) return;
    setBusy(verb);
    setFailure('');
    try {
      await run(verb);
      setLanded(true);
    } catch (error) {
      setFailure(error.sentence || t('gym.proposals.notDecided', { verb, reason: failureReason(error) }));
    } finally {
      setBusy(null);
    }
  };
  return { busy, failure, decide, settled };
}

// Reject | Apply. In the room the card closes on its pills (08W.25); over a workout on design-system Buttons (WD7.1). Apply is
// the prominent one but a routine's while a workout is open: this workout's card then holds the one prominent Apply (08.56P).
function Decision({ busy, failure, quiet, onDecide }) {
  const form = useContext(CoachForm);
  const apply = busy === 'apply' ? t('gym.coach.proposal.applying') : failure ? t('gym.coach.access.tryAgain') : t('gym.coach.proposal.apply');
  return <>
    {failure && <p className="gym-coach-proposal-failure" role="alert">{failure}</p>}
    {form === 'workout'
      ? <div className="gym-coach-proposal-decide">
        <Button variant="secondary" full disabled={Boolean(busy)} onClick={() => onDecide('dismiss')}>{t('gym.coach.proposal.reject')}</Button>
        <Button variant={quiet ? 'secondary' : 'primary'} full disabled={Boolean(busy)} onClick={() => onDecide('apply')}>{apply}</Button>
      </div>
      : <div className="gym-coach-proposal-decide">
        <button type="button" className="gym-coach-proposal-reject" disabled={Boolean(busy)} onClick={() => onDecide('dismiss')}>{t('gym.coach.proposal.reject')}</button>
        <button type="button" className={`gym-coach-proposal-apply${quiet ? ' is-quiet' : ''}`} disabled={Boolean(busy)} onClick={() => onDecide('apply')}>{apply}</button>
      </div>}
  </>;
}

// A routine proposal under the answer whose call made it (08W.25–08W.28): pending with Reject and Apply, applied,
// rejected, or out of date; while a workout is open it waits for next time (WD7). Apply and Reject are the lifter's
// gestures and the server's commands; no ability decides one.
export function CoachProposalCard({ id, movements }) {
  const api = useGymApi();
  const card = useDomainRead((read) => routineCard(read, id), [id]).data;
  const { busy, failure, decide, settled } = useDecision(async (verb) => {
    if (verb === 'apply') await api.applyProposal(id);
    else await api.dismissProposal(id);
  });
  if (!card) return null;
  const { diff, name, state } = card;
  if (state === 'dismissed') {
    return <p ref={settled} tabIndex={-1} className="gym-coach-proposal-rejected"><CircleSlash size={18} aria-hidden="true" />{t('gym.coach.proposal.rejected', { name })}</p>;
  }
  const applied = state === 'applied';
  const pending = state === 'pending' && !card.outOfDate;
  const outOfDate = !applied && !pending;
  const Symbol = applied ? CircleCheck : outOfDate ? AlertCircle : List;
  const waiting = card.nextTime ? t('gym.coach.proposal.nextTime', { count: diff.blocks.length }) : t('gym.coach.proposal.suggested', { count: diff.blocks.length });
  return <section className={`gym-coach-proposal-card${outOfDate ? ' is-out-of-date' : ''}`} aria-label={name}>
    <header ref={applied ? settled : undefined} tabIndex={applied ? -1 : undefined}>
      <Symbol size={22} aria-hidden="true" className={outOfDate ? undefined : 'gym-coach-made-check'} />
      <span>
        <strong>{applied ? t('gym.coach.proposal.applied', { name }) : outOfDate ? t('gym.coach.proposal.outOfDate', { name }) : name}</strong>
        {outOfDate ? t('gym.coach.proposal.outOfDateLine', { name }) : applied ? t('gym.coach.proposal.changes', { count: diff.blocks.length }) : waiting}
      </span>
    </header>
    <Changes diff={diff} movements={movements} name={name} />
    {pending && <Decision busy={busy} failure={failure} quiet={card.nextTime} onDecide={decide} />}
  </section>;
}

// Why a workout proposal can no longer be applied, in one sentence and then that nothing was applied (08.57): the board's
// for a movement logged since and a newer suggestion, a changed or finished workout; and, for what the log refused that the
// copy does not show, a suggestion answered elsewhere, a load under a movement's floor (which this copy's rules refuse an
// Apply for too), or that it is out of date.
function staleLine(stale, movements) {
  switch (stale.reason) {
    case 'replaced': return t('gym.coach.workoutProposal.replaced');
    case 'workout-finished': return t('gym.coach.workoutProposal.finished');
    case 'workout-changed': return t('gym.coach.workoutProposal.changed');
    case 'workout-moved': return typeof stale.exerciseId === 'string'
      ? t('gym.coach.workoutProposal.logged', { movement: nameOfMovement(movements, stale.exerciseId) }) : t('gym.coach.workoutProposal.loggedMovement');
    case 'settled': return t('gym.coach.workoutProposal.answered');
    case 'invalid': return t('gym.coach.workoutProposal.belowFloor');
    default: return t('gym.coach.workoutProposal.stale');
  }
}

// Coach's change to the open workout under the answer whose call made it, this browser's or a phone's (WD7, 08.56P),
// read from the copy: pending with Reject and the prominent Apply, which rewrites this workout's plan on the browser's copy
// and never a logged movement; applied, one line; rejected, one line; out of date, one sentence of why and nothing applied
// (WD7.3), which is also what a decision the log refused draws, never a failure. An Apply this copy's rules refuse for a
// load under a movement's floor draws the log's `invalid` the same way, its sentence taking the focus: no Try again could
// take it.
export function WorkoutProposalCard({ id, movements }) {
  const api = useGymApi();
  const { notices } = useSyncRecords('self/gym');
  const card = useDomainRead((read) => workoutCard(read, id, notices), [id, notices]).data;
  const [floored, setFloored] = useState(null);
  const { busy, failure, decide, settled } = useDecision(async (verb) => {
    try { await (verb === 'apply' ? api.applyWorkoutProposal(id) : api.dismissWorkoutProposal(id)); }
    catch (error) {
      if (error.code !== 'load-floor') throw error;
      setFloored(decisionRefusal('invalid'));
    }
  });
  if (!card) return null;
  const title = t('gym.coach.workoutProposal.title');
  if (card.state === 'dismissed') {
    return <p ref={settled} tabIndex={-1} className="gym-coach-proposal-rejected"><CircleSlash size={18} aria-hidden="true" />{t('gym.coach.workoutProposal.rejected')}</p>;
  }
  if (card.state === 'applied') {
    return <section className="gym-coach-proposal-card is-settled" aria-label={title}>
      <p ref={settled} tabIndex={-1} className="gym-coach-proposal-settled"><Check size={18} aria-hidden="true" className="gym-coach-made-check" />{t('gym.coach.workoutProposal.applied')}</p>
    </section>;
  }
  const stale = card.stale ?? floored;
  return <section className={`gym-coach-proposal-card is-workout${stale ? ' is-out-of-date' : ''}`} aria-label={title}>
    <header>
      <ClipboardList size={20} aria-hidden="true" className="gym-coach-made-check" />
      <span><strong>{title}</strong>{stale ? t('gym.coach.workoutProposal.outOfDate') : t('gym.coach.workoutProposal.count', { count: card.count })}</span>
    </header>
    {stale ? <p ref={settled} tabIndex={-1} className="gym-coach-proposal-why">{staleLine(stale, movements)}</p> : <>
      <Changes diff={card.diff} movements={movements} name={title} />
      <Decision busy={busy} failure={failure} quiet={false} onDecide={decide} />
    </>}
  </section>;
}
