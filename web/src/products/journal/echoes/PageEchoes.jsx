// Everything an echo draws inside a page: the tab on the edge, the ink the tab opens, and — once
// ever — the card that says what an echo is.
//
// An echo belongs to its page permanently, so it is marked the way you mark a book: a tab on the
// edge, level with the paragraph it belongs to, carrying nothing but its count. It never appears
// above the cursor, never animates, and never differs between a subscriber and everyone else.
// Hiding it made the canvas quietly dishonest — the journal had found something and said nothing.
//
// What differs is one tap in. With One the passage arrives whole, and everything else found under
// it. Without One the nearest passage stops mid-clause, the words it withheld are counted, and the
// page it came from stays free to scroll to — because One sells the finding, never access to your
// own writing.

import React, { useEffect, useRef } from 'react';
import { FreePath, InkDates, InkRow } from './Ink.jsx';

// Newest reads first and nothing is dimmed past legibility, so the ladder stops at half.
const LADDER = [1, 0.82, 0.64, 0.5];

export function PageEchoes({ echoes, day, standing = false }) {
  const { verify } = echoes;
  const page = echoes.pageOf(day);
  const open = echoes.openDay === day;
  const first = echoes.firstEchoDay === day;

  // The tab carries a count while it is closed, so the count has to be one the reader could check —
  // which means the quotes behind it must already have been re-located in their live pages. Verify
  // on mount, not on open: a number that shrinks the moment you touch it was never true.
  useEffect(() => { verify(day); }, [verify, day]);

  if (!page) return null;
  return (
    <>
      <EdgeTab
        count={page.matches.length}
        state={open ? 'open' : (standing ? 'current' : 'aged')}
        onClick={() => (open ? echoes.closeInk() : echoes.openInk(day))}
      />
      {open && <PageInk echoes={echoes} page={page} />}
      {first && <FirstEcho echoes={echoes} page={page} />}
    </>
  );
}

// The tab: 24 × 26, hung off the right edge with no right border, so it runs off the page rather
// than sitting near it. It says the count and nothing else — no word, no icon, no dot — and it is
// the close control once its ink is open. Present when the page loads; it never arrives.
function EdgeTab({ count, state, onClick }) {
  const closing = state === 'open';
  return (
    <button
      type="button"
      className={`je-tab je-tab-${state}`}
      onClick={onClick}
      aria-expanded={closing}
      aria-label={closing ? 'Close what you wrote before' : `${count} passages you wrote before`}
    >
      <span className="je-tab-face" aria-hidden="true">
        {closing ? (
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        ) : count}
      </span>
    </button>
  );
}

// The ink, in place. With One it is every passage found, oldest at the bottom. Without One it is the
// nearest, cut, then every other date — all of them, because the tab already said how many there are
// and a count whose members you cannot reach is not a fact.
//
// Named for where it opens, not for what it is made of: `Ink.jsx` is the shared parts every surface
// draws an echo out of, and a local `Ink` here would read like the one thing that file does not export.
function PageInk({ echoes, page }) {
  const [nearest, ...rest] = page.matches;
  const ref = useRef(null);
  const scroller = echoes.canvas?.scroller ?? null;

  // "The surface grows downward and tonight's text moves up" — the canvas has to actually move, or
  // a tap on the tab appends something below the fold and looks like nothing happened. Forward only,
  // and only within a screen of where you already are: a page you tapped gets nudged into view, a
  // page you are still flying to is the flight's business and this must not fight it.
  useEffect(() => {
    if (!scroller || !ref.current) return;
    const frame = scroller.getBoundingClientRect();
    const rise = ref.current.getBoundingClientRect().top - (frame.top + frame.height * 0.42);
    if (rise > 0 && rise < frame.height) scroller.scrollTop += rise;
  }, [scroller, page.day]);

  if (page.entitled) {
    return (
      <div className="je-ink" ref={ref}>
        {page.matches.map((match, index) => (
          <InkRow
            key={match.day}
            match={match}
            triggerDay={page.day}
            dim={LADDER[Math.min(index, LADDER.length - 1)]}
            onOpen={() => echoes.walkTo(page.day, match)}
            onUseful={() => echoes.markUseful(page.day, match.day)}
            onNotUseful={() => echoes.retireMatch(page.day, match.day)}
          />
        ))}
      </div>
    );
  }
  // The cut passage can be answered too. A reader without One still sees the date, the distance and
  // the opening words, which is enough to know whether the journal reached back at anything real —
  // and an answer only subscribers may give measures only subscribers.
  return (
    <div className="je-ink" ref={ref}>
      <InkRow
        match={nearest}
        triggerDay={page.day}
        onOpen={() => echoes.openSheet(page.day)}
        onUseful={() => echoes.markUseful(page.day, nearest.day)}
        onNotUseful={() => echoes.retireMatch(page.day, nearest.day)}
      />
      <InkDates matches={rest} onOpen={(match) => echoes.walkTo(page.day, match)} />
      <FreePath match={nearest} />
    </div>
  );
}

// Said once, below tonight's page, never during the first run and never with a fanfare. An echo
// needs months, so offering it early sells nothing real. From now on it is the tab on the edge.
function FirstEcho({ echoes, page }) {
  const { claimFirstEcho } = echoes;
  useEffect(() => { claimFirstEcho(); }, [claimFirstEcho]);
  const [nearest] = page.matches;
  return (
    <div className="je-first">
      <p className="je-first-lead">Something you wrote before is close to tonight.</p>
      <p className="je-first-note">
        This is the first time that’s happened. From now on it’s the tab on the edge.
      </p>
      <InkRow match={nearest} triggerDay={page.day} onOpen={() => echoes.walkTo(page.day, nearest)} />
    </div>
  );
}
