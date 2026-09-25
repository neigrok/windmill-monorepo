import React, { useState } from 'react';
import { Button } from '../../../design-system/index.js';
import { Back } from '../Back.jsx';
import { gymApi } from '../gymApi.js';
import { COACH_HREF, THREADS_HREF, threadHref } from '../log.js';
import { ProposalPanel } from '../Proposals.jsx';
import { useGymRead } from '../useGymRead.js';
import { COACH_TITLE } from './coach.js';
import { CoachRoom } from './CoachRoom.jsx';
import { forgetCoachDraft } from './useCoachConversation.js';
import {
  askedLabel, monthsOf, NEW_THREAD_VERB, NO_THREADS, outcomeChip, outcomeLine,
  THREAD_ABSENT, THREAD_DELETE_DETAIL, THREAD_DELETED, THREAD_FAILED, threadDeleteFailure,
  THREADS_FAILED, THREADS_TITLE,
} from './threads.js';

export function ThreadsList({ log, accountId }) {
  const view = useGymRead(() => gymApi.threads({ limit: 50 }), []);
  const [pages, setPages] = useState([]);
  const [more, setMore] = useState({ busy: false, note: '' });
  const nextCursor = pages.length ? pages[pages.length - 1].nextCursor : view.data?.nextCursor;
  const loadMore = async () => {
    if (!nextCursor || more.busy) return;
    setMore({ busy: true, note: '' });
    try {
      const page = await gymApi.threads({ limit: 50, cursor: nextCursor });
      setPages((held) => [...held, page]);
      setMore({ busy: false, note: '' });
    } catch {
      setMore({ busy: false, note: 'Earlier conversations didn’t load. Try again.' });
    }
  };

  // A conversation the window is holding is off this list for the length of its window — the room's
  // transient is the only place it still exists, and the only way back — and off it for good once
  // the store has answered. A refused delete needs no re-read: the read this list already holds was
  // taken while the conversation was there, and there is where the store kept it. The other question
  // is what the ACCOUNT holds, which is the stance's, and the settled delete
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
  const unique = new Map([...(view.data?.threads ?? []), ...pages.flatMap((page) => page.threads)].map((thread) => [thread.id, thread]));
  const conversations = [...unique.values()].filter((thread) => !settled.has(thread.id));
  const threads = conversations.filter((thread) => !withheld.has(thread.id));

  return (
    <section className="gym-threads">
      <Back href={COACH_HREF}>{COACH_TITLE}</Back>
      <header className="gym-threads-head">
        <h1 className="gym-title">{THREADS_TITLE}</h1>
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

      {more.note && <p className="gym-coach-note" role="status">{more.note}</p>}
      {nextCursor && <button type="button" className="gym-coach-older" disabled={more.busy} onClick={loadMore}>
        {more.busy ? 'Loading…' : 'Earlier conversations'}
      </button>}
      <a className="gym-threads-new" href={COACH_HREF} onClick={() => forgetCoachDraft(accountId)}>{NEW_THREAD_VERB}</a>
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

export function ThreadDetail({ id, log, accountId }) {
  const view = useGymRead(() => gymApi.thread(id, { limit: 50 }), [id]);
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
  const remove = () => {
    log.withhold({
      kind: 'thread',
      id,
      line: THREAD_DELETED,
      detail: THREAD_DELETE_DETAIL,
      send: async () => { await gymApi.deleteThread(id); forgetCoachDraft(accountId, id); },
      refused: (error) => log.say(threadDeleteFailure(error)),
    });
    window.location.hash = THREADS_HREF;
  };
  return (
    <section className="gym-thread">
      <h2 className="gym-thread-name gym-visually-hidden">{thread.title}</h2>

      <CoachRoom key={thread.id} log={log} accountId={accountId} initialThread={thread} onDelete={remove} />

      {thread.proposals?.length > 0 && !thread.turns?.some((turn) => turn.receipt?.proposals?.length) && (
        <section className="gym-thread-proposals">
          <h2 className="gym-history-head">What it proposed</h2>
          {thread.proposals.map((head) => <ProposalPanel key={head.id} id={head.id} log={log} onChanged={view.refresh} />)}
        </section>
      )}

    </section>
  );
}
