// ASK HAS A PAST (§O, screen 33) — the list of conversations, and one conversation read back.
//
// THE LIST IS NOT A CHAT INBOX. Every row is the question in the lifter's own words plus what came
// of it, because that is what somebody comes back looking for six weeks later; there is no unread
// mark, no badge, no count on the door that leads here, no search box and no folders, and nothing
// on this screen resurfaces a conversation on its own. The rules and every word of the copy are in
// threads.js, where the reasons are written down beside them.
//
// TWO SCREENS IN ONE FILE because they are one object read at two depths: the list is a row per
// thread and the detail is that row opened. Splitting them would put the same outcome line in two
// files, and the outcome line is the whole promise this section makes.
//
// THE DETAIL READS AND IT DOES NOT WRITE, apart from the delete. There is no composer on it: an old
// conversation is a record of what was asked and answered, and Ask is entered from its own room —
// which is also the shape the wire has, where `turns` arrive on the detail read alone.

import React, { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { EXPORT_THREADS_HREF, gymApi } from '../gymApi.js';
import { ASK_HREF, proposalHref, routineHref, THREADS_HREF, threadHref, whenLabel } from '../log.js';
import { changeLabel, stateChip } from '../proposals.js';
import { useGymRead } from '../useGymRead.js';
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
        <BackToAsk />
        <p className="gym-read-failed">
          {THREADS_FAILED}
          <button type="button" className="gym-retry" onClick={view.retry}>Retry</button>
        </p>
      </>
    );
  }

  // `absent` cannot arrive on this read — the list answers `[]` for an account that has never asked
  // — so an empty list and a missing one are one branch, and it is the one that is honest either way.
  const threads = view.data ?? [];

  return (
    <section className="gym-threads">
      <BackToAsk />
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

      <a className="gym-threads-new" href={ASK_HREF}>{NEW_THREAD_VERB}</a>

      {/* THE FILE, offered where the conversations are (§O). It is a navigation and not a fetch —
          the browser follows the link and the server answers with a Content-Disposition — so a
          lifter with years of them does not have to hold the lot in a tab first. */}
      {threads.length > 0 && (
        <a className="gym-threads-export" href={EXPORT_THREADS_HREF}>
          <span className="gym-threads-export-verb">{EXPORT_THREADS_VERB}</span>
          <span className="gym-threads-export-line">{EXPORT_THREADS_LINE}</span>
        </a>
      )}
    </section>
  );
}

// ONE ROW: the question, in the lifter's own words and byte for byte, over what came of it. The title
// is drawn exactly as the wire carried it — no truncation, no ellipsis, nothing this surface wrote —
// because a row that improved somebody's own sentence is the summary §O bans, arriving as a courtesy.
//
// The chip and the line are two readings of the same `outcome` and both are the SERVER's: it derives
// the outcome from the proposals the thread minted, so every one of these can be checked by opening
// the routine underneath it. A kind this build does not know draws its line as nothing rather than
// as a guess.
function ThreadRow({ thread }) {
  const chip = outcomeChip(thread.outcome);
  const line = outcomeLine(thread.outcome);
  // The one row that carries the brand is one whose changes were APPLIED — a fact about the
  // lifter's program, and the only thing on this list worth finding at a glance. It is not an alert
  // and there is nothing here to clear.
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

function BackToAsk() {
  return (
    <a className="gym-back" href={ASK_HREF}>
      <ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Ask
    </a>
  );
}

// ONE CONVERSATION, READ BACK — the question that titles it, every turn in the order they were sent,
// what came of it, and the delete. The turns are the STORE's: they are what the model was given, not
// what a client once had on screen, which is the whole reason §O reversed W7.
export function ThreadDetail({ id }) {
  const view = useGymRead(() => gymApi.thread(id), [id]);

  if (view.phase === 'loading') return <p className="gym-quiet">Opening the conversation…</p>;
  if (view.phase === 'absent') {
    return (
      <>
        <BackToThreads />
        <p className="gym-quiet">{THREAD_ABSENT}</p>
      </>
    );
  }
  if (view.phase === 'failed') {
    return (
      <>
        <BackToThreads />
        <p className="gym-read-failed">
          {THREAD_FAILED}
          <button type="button" className="gym-retry" onClick={view.retry}>Retry</button>
        </p>
      </>
    );
  }

  const thread = view.data;
  return (
    <section className="gym-thread">
      <BackToThreads />
      {/* THE TITLE IS THE FIRST MESSAGE, VERBATIM, and it is the page's h1 — the same sentence the
          row carried, so the list and the conversation cannot disagree about what was asked. */}
      <header className="gym-thread-head">
        <h1 className="gym-thread-name">{thread.title}</h1>
        <Outcome outcome={thread.outcome} />
      </header>

      <ol className="gym-ask-thread">
        {thread.turns?.map((turn, index) => (
          <li
            className={turn.from === 'lifter' ? 'gym-ask-turn is-lifter' : 'gym-ask-turn is-ask'}
            key={`${turn.from}-${index}`}
          >
            <p className="gym-ask-text">{turn.text}</p>
            {/* WHEN IT WAS SAID, and only here. The room draws no timestamps at all — a conversation
                you are having does not need them — and a conversation you are reading six weeks
                later is exactly the one that does. There is no receipt under these answers: the
                counts were the SERVER's about one exchange (ask.js) and this read carries none, so
                nothing is drawn rather than a number this screen assembled. */}
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
                <a className="gym-history-row" href={proposalHref(head.id)}>
                  <span className="gym-history-line">
                    {`${changeLabel(head.changeCount)} to ${head.routine} · ${stateChip(head)?.toLowerCase() ?? head.state}`}
                  </span>
                  <span className="gym-history-go" aria-hidden="true">›</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <DeleteThread id={thread.id} />
    </section>
  );
}

// WHAT CAME OF IT, and the trail back to the program. An applied conversation names the routine it
// changed as a door — §O's "the trail runs both ways" — and it is offered only where the wire named
// one: changes that spanned two routines carry no routineId at all, and a link this screen invented
// would open the wrong program.
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

// THE ONE WRITE ON THIS SCREEN, and it says what it does before it is tapped rather than in a toast
// after: the messages go, and the change you applied stays in the routine's history, because that is
// a fact about your program rather than a message. Two taps, because it cannot be undone — the same
// shape the discard at the finish has, and for the same reason.
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
      {note && <p className="gym-ask-note">{note}</p>}
    </section>
  );
}

function BackToThreads() {
  return (
    <a className="gym-back" href={THREADS_HREF}>
      <ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> {THREADS_TITLE}
    </a>
  );
}
