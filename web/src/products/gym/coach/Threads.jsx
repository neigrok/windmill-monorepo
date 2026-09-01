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
  askedLabel, conversationsLine, DELETE_VERB, EXPORT_THREADS_LINE,
  EXPORT_THREADS_VERB, monthsOf, NEW_THREAD_VERB, NO_THREADS, outcomeChip, outcomeLine,
  THREAD_ABSENT, THREAD_DELETE_DETAIL, THREAD_DELETED, THREAD_FAILED, threadDeleteFailure,
  THREADS_FAILED, THREADS_TITLE,
} from './threads.js';

export function ThreadsList({ log }) {
  const view = useGymRead(() => gymApi.threads(), []);

  // A conversation the window is holding is off this list for the length of its window — the room's
  // transient is the only place it still exists, and the only way back — and off it for good once
  // the store has answered. A refused delete needs no re-read: the read this list already holds was
  // taken while the conversation was there, and there is where the store kept it. The other question
  // is what the ACCOUNT holds, which is the stance's and the export door's, and the settled delete
  // leaves that read as well as the rows: this list is never read again inside one visit.
  const settled = log.gone('thread');
  const withheld = log.hidden('thread');

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

  // The read, answered TWICE: the account's conversations, and the rows the window leaves.
  const conversations = (view.data ?? []).filter((thread) => !settled.has(thread.id));
  const threads = conversations.filter((thread) => !withheld.has(thread.id));

  return (
    <section className="gym-threads">
      <Back href={COACH_HREF}>{COACH_TITLE}</Back>
      <header className="gym-threads-head">
        <h1 className="gym-title">{THREADS_TITLE}</h1>
        {/* The rows', not the account's: it counts the list under it, and gates nothing. */}
        {threads.length > 0 && <p className="gym-threads-count">{conversationsLine(threads.length)}</p>}
      </header>

      {/* Off the ACCOUNT: an account holding one conversation the window has taken off the list is
          not an account with nothing in it. Between the two stances the list draws neither. */}
      {conversations.length === 0 && <p className="gym-quiet">{NO_THREADS}</p>}

      {monthsOf(threads).map((month) => (
        <section className="gym-threads-month" key={month.key}>
          <h2 className="gym-threads-month-head">{month.label}</h2>
          <ul className="gym-threads-rows">
            {month.threads.map((thread) => <li key={thread.id}><ThreadRow thread={thread} /></li>)}
          </ul>
        </section>
      ))}

      <a className="gym-threads-new" href={COACH_HREF}>{NEW_THREAD_VERB}</a>

      {/* The door reads the ACCOUNT: the export carries every message the store holds, which one
          held delete has not changed, and a door to all of it may not disappear for nine seconds. */}
      {conversations.length > 0 && (
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

  // The window is holding this conversation's delete, so it is as gone from here as it is from the
  // list — a back gesture may not walk into a room the room says is deleted. The transient carries
  // the only way back, and it follows the lifter here.
  if (log.hidden('thread').has(id)) {
    return (
      <>
        <Back href={THREADS_HREF}>{THREADS_TITLE}</Back>
        <p className="gym-quiet">{THREAD_ABSENT}</p>
      </>
    );
  }
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

      <DeleteThread id={thread.id} log={log} />
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

// Withheld like every other delete in this room, and a conversation lives only on the store — which
// is exactly why it is HELD and not sent: an Undo offered over a send already made would be a lie.
// The lifter is put back on the list at once, nothing reaches the store for the length of the
// window, and the room's transient carries the only way back. Nothing is confirmed, because a
// question in front of an act that can be undone is ceremony (13-gestures.md Law 2).
//
// What the delete leaves behind rides the window as its `detail`, so it is read at the moment of the
// act rather than standing over the button on every visit.
function DeleteThread({ id, log }) {
  const remove = () => {
    log.withhold({
      kind: 'thread',
      id,
      line: THREAD_DELETED,
      detail: THREAD_DELETE_DETAIL,
      send: () => gymApi.deleteThread(id),
      refused: (error) => log.say(threadDeleteFailure(error)),
    });
    window.location.hash = THREADS_HREF;
  };

  return (
    <section className="gym-thread-delete">
      <button type="button" className="gym-thread-delete-verb" onClick={remove}>{DELETE_VERB}</button>
    </section>
  );
}
