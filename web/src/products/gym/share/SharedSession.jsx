// THE COACH'S PAGE — one workout, opened by somebody with no account, and the only surface in gym
// that means anything signed out. The token in the URL is the whole credential (gymApi.js), so this
// screen never asks who is reading and never waits for auth to resolve.
//
// IT OFFERS NO DOOR THAT WOULD IMPLY THE WORKOUT IS THEIRS. No tab bar, no account seat, no product
// switcher, no "open your log", no sign-in pitch — a coach did not come here to make an account, and
// a page that treats a link as a funnel is the dark pattern this product exists without. What is
// here is the workout, what the link is, and nothing else.
//
// IT SAYS WHO IT IS FROM ONLY BECAUSE THE LIFTER SENT IT. The wire carries no name, no email and no
// id at any depth — deliberately — so nothing on this page can name an account, and it does not
// invent one. "Shared by the person who trained it" is the whole of what is known here.

import React from 'react';
import { gymApi } from '../gymApi.js';
import {
  CLOSED_ITSELF_NOTE, closedOnItsOwn, dayLabel, fmt, NO_ROUTINE, sessionMetaLabel, timeLabel,
  topSetLabel, topSetOf,
} from '../log.js';
import { KG, spellWeightsIn } from '../units.js';
import { useGymRead } from '../useGymRead.js';
import { SHARED_ABSENT, SHARED_TERMS, sharedGroups } from './share.js';

export function SharedSession({ token }) {
  // THE PAGE WITH NO ACCOUNT BEHIND IT SPELLS KILOGRAMS, and it is the page that has to say so
  // itself. The spelling is one module-level value (units.js) set by the two surfaces that read an
  // account — the rooms as they open, and the settings row as it is moved — and this branch is
  // answered BEFORE either of them (GymApp.jsx). So in a tab that had a pounds-reading log open, the
  // coach's page inherited that setting: `226 × 5` for the owner, `102.5 × 5` for the coach, on one
  // document with no unit word anywhere on it and nothing to tell the two readings apart.
  //
  // IN THE RENDER AND NOT IN AN EFFECT, deliberately. `fmt` reads this value while the numbers below
  // are being built, and an effect runs after the paint that already printed them — and sets no
  // state, so nothing would draw them again. The call is idempotent, which is what makes running it
  // on every render of this page the whole of the fix.
  spellWeightsIn(KG);
  const view = useGymRead(() => gymApi.sharedSession(token), [token]);

  if (view.phase === 'loading') return <main className="gym-column"><p className="gym-quiet">Opening the workout…</p></main>;

  // Revoked, expired and never-minted are one answer on the wire, and this page does not guess which
  // — a page that said "this expired" would be telling a stranger that the token was once real.
  if (view.phase === 'absent') {
    return (
      <main className="gym-column gym-shared">
        <h1 className="gym-title">{SHARED_ABSENT.title}</h1>
        <p className="gym-quiet gym-shared-absent">{SHARED_ABSENT.body}</p>
      </main>
    );
  }

  if (view.phase === 'failed') {
    return (
      <main className="gym-column gym-shared">
        <p className="gym-read-failed">
          This didn’t load.
          <button type="button" className="gym-retry" onClick={view.retry}>Retry</button>
        </p>
      </main>
    );
  }

  const shared = view.data;
  const sets = shared.sets ?? [];
  const top = topSetOf(shared, sets);
  return (
    <main className="gym-column gym-shared">
      <p className="gym-shared-kicker">A shared workout</p>
      <header className="gym-detail-head">
        <h1 className="gym-title">
          {dayLabel(shared.startedAt)}
          <span className="gym-detail-routine">{`  ·  ${shared.routine ?? NO_ROUTINE}`}</span>
        </h1>
        <p className="gym-detail-when">{sessionMetaLabel(shared, sets.length)}</p>
        {top && <p className="gym-detail-top">{`top set  ·  ${topSetLabel(top)}`}</p>}
        {closedOnItsOwn(shared, sets) && <p className="gym-detail-closed">{CLOSED_ITSELF_NOTE}</p>}
      </header>

      {sets.length === 0 && <p className="gym-quiet">No sets in this session.</p>}
      {sharedGroups(sets).map(([exercise, group]) => (
        <section className="gym-exercise" key={exercise}>
          <h2 className="gym-exercise-name">{exercise}</h2>
          <ul className="gym-sets">
            {/* No set on this wire has an id — nothing here is addressable, which is the point — so
                the row is keyed the way a routine's repeated movement is: by its place in the list
                beside the number the store gave it. */}
            {group.map((set, index) => (
              <li key={`${set.setNumber}-${index}`} className={set.kind === 'warmup' ? 'gym-set gym-set-warmup' : 'gym-set'}>
                <span className="gym-set-number">{set.setNumber}</span>
                <span className="gym-set-load">{`${fmt(set.weightKg)} × ${set.reps}`}</span>
                {set.kind !== 'working' && <span className="gym-set-kind">{set.kind}</span>}
                {set.rpe != null && <span className="gym-set-rpe">rpe {set.rpe}</span>}
                <span className="gym-set-time">{timeLabel(set.completedAt)}</span>
                {set.note && <span className="gym-set-note">{set.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <footer className="gym-shared-foot">
        {SHARED_TERMS.map((term) => <p key={term}>{term}</p>)}
      </footer>
    </main>
  );
}
