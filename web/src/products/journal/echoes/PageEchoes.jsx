// Everything an echo draws inside a page: the tab on the edge, the ink it opens, the once-ever card.
// The tab is the same with or without One; what differs is one tap in.

import React, { useEffect, useRef } from 'react';
import { FreePath, InkDates, InkRow } from './Ink.jsx';

// Nothing is dimmed past legibility, so the ladder stops at half.
const LADDER = [1, 0.82, 0.64, 0.5];

export function PageEchoes({ echoes, day, standing = false }) {
  const { verify } = echoes;
  const page = echoes.pageOf(day);
  const open = echoes.openDay === day;
  const first = echoes.firstEchoDay === day;

  // The tab carries a count while closed, so quotes are re-located on mount, not on open.
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

// The tab says the count, and is the close control once its ink is open.
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

// With One, every passage found, oldest at the bottom; without One, the nearest cut, then the dates.
function PageInk({ echoes, page }) {
  const [nearest, ...rest] = page.matches;
  const ref = useRef(null);
  const scroller = echoes.canvas?.scroller ?? null;

  // Forward only, and only within a screen: a page still being flown to is the flight's business.
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
  // The cut passage can be answered too.
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

// Said once, below tonight's page, never during the first run.
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
