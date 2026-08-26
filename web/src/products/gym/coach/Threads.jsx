import React, { useState } from 'react';
import { Button } from '../../../design-system/index.js';
import { Back } from '../Back.jsx';
import { EXPORT_THREADS_HREF, gymApi } from '../gymApi.js';
import { COACH_HREF, proposalHref, routineHref, THREADS_HREF, threadHref, whenLabel } from '../log.js';
import { changeLabel, isPending, receiptLine, stateChip, STILL_WAITING } from '../proposals.js';
import { ProposalReview } from '../Proposals.jsx';
import { useGymRead } from '../useGymRead.js';
import { COACH_TITLE } from './coach.js';
import {
  askedLabel, conversationsLine, DELETE_CONFIRM, DELETE_FAILED, DELETE_NOTE, DELETE_VERB,
  EXPORT_THREADS_LINE, EXPORT_THREADS_VERB, monthsOf, NEW_THREAD_VERB, NO_THREADS, outcomeChip,
  outcomeLine, THREAD_ABSENT, THREAD_FAILED, THREADS_FAILED, THREADS_TITLE,
} from './threads.js';

export function ThreadsList() {
  const view = useGymRead(() => gymApi.threads(), []);

  if (view.phase === 'loading') return <p className="gym-quiet">Opening your conversations…</p>;
  if (view.phase === 'failed') {
    return (
      <>
        <Back href={COACH_HREF}>{COACH_TITLE}</Back>
        <p className="gym-read-failed">
          {THREADS_FAILED}
          <Button variant="secondary" size="sm" onClick={view.retry}>Retry</Button>
        </p>
      </>
    );
  }

  const threads = view.data ?? [];

  return (
    <section className="gym-threads">
      <Back href={COACH_HREF}>{COACH_TITLE}</Back>
      <header className="gym-threads-head">
        <h1 className="gym-title">{THREADS_TITLE}</h1>
        {threads.length > 0 && <p className="gym-threads-count">{conversationsLine(threads.length)}</p>}
      </header>

      {threads.length === 0 && <p className="gym-quiet">{NO_THREADS}</p>}

      {monthsOf(threads).map((month) => (
        <section className="gym-threads-month" key={month.key}>
          <h2 className="gym-threads-month-head">{month.label}</h2>
          <ul className="gym-threads-rows">
            {month.threads.map((thread) => <li key={thread.id}><ThreadRow thread={thread} /></li>)}
          </ul>
        </section>
      ))}

      <a className="gym-threads-new" href={COACH_HREF}>{NEW_THREAD_VERB}</a>

      {threads.length > 0 && (
        <a className="gym-threads-export" href={EXPORT_THREADS_HREF}>
          <span className="gym-threads-export-verb">{EXPORT_THREADS_VERB}</span>
          <span className="gym-threads-export-line">{EXPORT_THREADS_LINE}</span>
        </a>
      )}
    </section>
  );
}

function ThreadRow({ thread }) {
  const chip = outcomeChip(thread.outcome);
  const line = outcomeLine(thread.outcome);
  const applied = thread.outcome?.kind === 'applied';
  return (
    <a className={applied ? 'gym-thread-row is-applied' : 'gym-thread-row'} href={threadHref(thread.id)}>
      <span className="gym-thread-title">{thread.title}</span>
      <span className="gym-thread-meta">
        {chip && <span className={`gym-thread-chip is-${thread.outcome.kind}`}>{chip}</span>}
        {line && <span className="gym-thread-outcome">{line}</span>}
        <span className="gym-thread-when">{askedLabel(thread.askedAt)}</span>
      </span>
    </a>
  );
}

export function ThreadDetail({ id, log }) {
  const view = useGymRead(() => gymApi.thread(id), [id]);
  const [reviewing, setReviewing] = useState(null);
  // Receipts by proposal id, held for this visit only: the thread's stored shape carries no
  // settled-at, so on reopening they are gone and nothing pretends otherwise.
  const [receipts, setReceipts] = useState(() => new Map());

  if (view.phase === 'loading') return <p className="gym-quiet">Opening the conversation…</p>;
  if (view.phase === 'absent') {
    return (
      <>
        <Back href={THREADS_HREF}>{THREADS_TITLE}</Back>
        <p className="gym-quiet">{THREAD_ABSENT}</p>
      </>
    );
  }
  if (view.phase === 'failed') {
    return (
      <>
        <Back href={THREADS_HREF}>{THREADS_TITLE}</Back>
        <p className="gym-read-failed">
          {THREAD_FAILED}
          <Button variant="secondary" size="sm" onClick={view.retry}>Retry</Button>
        </p>
      </>
    );
  }

  const thread = view.data;
  return (
    <section className="gym-thread">
      <Back href={THREADS_HREF}>{THREADS_TITLE}</Back>
      <header className="gym-thread-head">
        <h1 className="gym-thread-name">{thread.title}</h1>
        <Outcome outcome={thread.outcome} />
      </header>

      <ol className="gym-coach-thread">
        {/* `from` is the wire's enum; anything that is not the lifter is drawn as the room's turn. */}
        {thread.turns?.map((turn, index) => (
          <li
            className={turn.from === 'lifter' ? 'gym-coach-turn is-lifter' : 'gym-coach-turn is-coach'}
            key={`${turn.from}-${index}`}
          >
            <p className="gym-coach-text">{turn.text}</p>
            <p className="gym-thread-said">{whenLabel(turn.at)}</p>
          </li>
        ))}
      </ol>

      {thread.proposals?.length > 0 && (
        <section className="gym-thread-proposals">
          <h2 className="gym-history-head">What it proposed</h2>
          <ul className="gym-history-rows">
            {thread.proposals.map((head) => (
              <li key={head.id}>
                <a
                  className="gym-history-row"
                  href={proposalHref(head.id)}
                  onClick={(event) => { event.preventDefault(); setReviewing(head.id); }}
                >
                  <span className="gym-history-line">
                    {`${changeLabel(head.changeCount)} to ${head.routine} · ${isPending(head) ? STILL_WAITING : stateChip(head)?.toLowerCase()}`}
                  </span>
                  <span className="gym-history-go" aria-hidden="true">›</span>
                </a>
                {receipts.get(head.id) && <p className="gym-coach-receipt" role="status">{receipts.get(head.id)}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {reviewing && (
        <ProposalReview
          key={reviewing}
          id={reviewing}
          log={log}
          onClose={() => setReviewing(null)}
          onChanged={view.refresh}
          onSettled={(settled) => {
            setReceipts((held) => new Map(held).set(reviewing, receiptLine(settled)));
            setReviewing(null);
            view.refresh();
          }}
        />
      )}

      <DeleteThread id={thread.id} />
    </section>
  );
}

function Outcome({ outcome }) {
  const chip = outcomeChip(outcome);
  const line = outcomeLine(outcome);
  if (!chip && !line) return null;
  return (
    <p className="gym-thread-outcome-line">
      {chip && <span className={`gym-thread-chip is-${outcome.kind}`}>{chip}</span>}
      {line && <span className="gym-thread-outcome">{line}</span>}
      {outcome?.routineId && (
        <a className="gym-thread-routine-door" href={routineHref(outcome.routineId)}>Open the routine ›</a>
      )}
    </p>
  );
}

function DeleteThread({ id }) {
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');

  const remove = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    try {
      await gymApi.deleteThread(id);
      window.location.hash = THREADS_HREF;
    } catch {
      setNote(DELETE_FAILED);
    }
  };

  return (
    <section className="gym-thread-delete">
      <p className="gym-thread-delete-note">{DELETE_NOTE}</p>
      <button type="button" className={confirming ? 'gym-thread-delete-verb is-armed' : 'gym-thread-delete-verb'} onClick={remove}>
        {confirming ? DELETE_CONFIRM : DELETE_VERB}
      </button>
      {note && <p className="gym-coach-note">{note}</p>}
    </section>
  );
}
