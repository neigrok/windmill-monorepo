// THE COACH PANEL — the second door onto the tools an agent drives over MCP, for a lifter who does
// not have an agent of their own. Same log, and seven of gym's seventeen tools — the reads, which are
// all CoachTools hands a panel; what is different is only that the model sits on our side of the
// wire. (The seventh is `get_preferences`, W4: what's in this gym is a fact about the workout on
// screen, so the panel reads it like every other one.)
//
// THE PAYWALL IS HONEST UP FRONT. It is the rule journal's TalkButton set and the reason it exists:
// the mic never records a non-subscriber's words only to lose them to a 403. Here that means a
// locked face with no composer at all — nobody types a question about their squats and then finds
// out it was never going to be answered. Only once the entitlement is confirmed does an input appear.
//
// IT SHOWS WHAT IT READ. Every answer carries the tools that produced it, in call order (coach.js).
// That line is not decoration: it is the difference between an instrument and a chatbot, and it is
// how a lifter can tell an answer that came from their log from one that came from nowhere.
//
// AND IT CAN BE ABSENT. A deployment with no model wired never mounts the route, so the first ask
// can come back "there is no coach here" — in which case the composer goes and the question the
// lifter typed stays on screen as their own turn, unanswered. Nothing they wrote disappears quietly.

import React, { useState } from 'react';
import { gymApi } from '../gymApi.js';
import { useEntitlements } from '../../../shell/billing/EntitlementsProvider.jsx';
import { beginUpgrade, paidPlansOpen } from '../../../shell/billing/checkout.js';
import {
  askFailure, COACH_LOCKED_NOTE, COACH_NOT_FOR_SALE, COACH_PLACEHOLDER, COACH_TERMS, COACH_TITLE,
  stepsLine, threadFor,
} from './coach.js';

// Drawn only inside the training room, which is signed-in by construction (GymApp), so there is no
// ghost branch here — a visitor never reaches a session detail to have a panel drawn under it.
export function CoachPanel({ sessionId }) {
  const [turns, setTurns] = useState([]);   // { from: 'lifter' | 'coach', text, steps? }
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  // Set to the sentence that closed the panel — no coach on this deployment, or a workout this
  // account cannot read. Either way asking again is not the repair, so the composer goes and this
  // takes its place. It holds the SENTENCE rather than a flag because the two reasons are different
  // facts and printing the wrong one is exactly the misinformation the panel is here to avoid.
  const [closed, setClosed] = useState('');
  const { loading: entLoading, windmillOne, refresh } = useEntitlements();

  const ask = async () => {
    const question = draft.trim();
    if (!question || asking) return;
    const thread = threadFor(turns, question);
    // The lifter's turn lands on screen BEFORE the request — so a reply that never comes leaves the
    // question they asked, not a cleared box and no explanation.
    setTurns((held) => [...held, { from: 'lifter', text: question }]);
    setDraft('');
    setNote('');
    setAsking(true);
    try {
      const reply = await gymApi.askCoach(sessionId, thread);
      setTurns((held) => [...held, { from: 'coach', text: reply.answer, steps: reply.steps }]);
    } catch (error) {
      const failure = askFailure(error);
      if (failure.gone) setClosed(failure.note);
      else setNote(failure.note);
      // The up-front gate makes a 403 the rare race — a subscription that lapsed, or one bought in
      // another tab. Re-read the truth so the panel re-locks rather than lying about it.
      if (failure.locked) refresh();
    }
    setAsking(false);
  };

  // The paywall, drawn before a single word is typed. While a signed-in account's entitlement is
  // still settling the panel holds a neutral face — never a locked flash for a subscriber.
  if (!windmillOne) {
    return (
      <section className="gym-coach">
        <h2 className="gym-coach-title">{COACH_TITLE}</h2>
        <p className="gym-coach-terms">{COACH_TERMS}</p>
        {entLoading ? (
          <p className="gym-coach-note">Checking your plan…</p>
        ) : (
          <>
            <p className="gym-coach-locked">{COACH_LOCKED_NOTE}</p>
            {/* The button appears only when there is something to buy. Windmill One is not on sale
                yet (shell/billing/checkout.js — paidPlansOpen), and an Upgrade that opens a checkout
                nobody can complete is the same manufactured urgency the pricing page took its own
                CTA down over. So the locked face says the plan is not open instead of pretending a
                door. The moment plans arm, the button is back with them. */}
            {paidPlansOpen() ? (
              <button
                type="button"
                className="gym-coach-upgrade"
                onClick={async () => {
                  const opened = await beginUpgrade({
                    onCompleted: () => { refresh(); setTimeout(refresh, 2500); },
                  });
                  if (!opened) setNote('Couldn’t open checkout.');
                }}
              >
                See Windmill One
              </button>
            ) : (
              <p className="gym-coach-note">{COACH_NOT_FOR_SALE}</p>
            )}
            {note && <p className="gym-coach-note">{note}</p>}
          </>
        )}
      </section>
    );
  }

  return (
    <section className="gym-coach">
      <h2 className="gym-coach-title">{COACH_TITLE}</h2>
      <p className="gym-coach-terms">{COACH_TERMS}</p>

      {turns.length > 0 && (
        <ol className="gym-coach-thread">
          {turns.map((turn, index) => (
            <li
              className={turn.from === 'lifter' ? 'gym-coach-turn is-lifter' : 'gym-coach-turn is-coach'}
              key={`${turn.from}-${index}`}
            >
              <p className="gym-coach-text">{turn.text}</p>
              {turn.from === 'coach' && <p className="gym-coach-read">{stepsLine(turn.steps)}</p>}
            </li>
          ))}
        </ol>
      )}
      {asking && <p className="gym-coach-note" role="status">Reading your log…</p>}
      {note && <p className="gym-coach-note">{note}</p>}

      {closed ? (
        <p className="gym-coach-locked">{closed}</p>
      ) : (
        <div className="gym-coach-compose">
          <textarea
            className="gym-coach-input"
            value={draft}
            rows={2}
            maxLength={1000}
            placeholder={COACH_PLACEHOLDER}
            aria-label="Ask about this workout"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, shift+Enter is a newline — the shape every composer in this brand uses.
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); ask(); }
            }}
          />
          <button
            type="button"
            className={draft.trim() === '' || asking ? 'gym-coach-ask is-inert' : 'gym-coach-ask'}
            onClick={ask}
            aria-busy={asking}
          >
            {asking ? 'Asking…' : 'Ask'}
          </button>
        </div>
      )}
    </section>
  );
}
