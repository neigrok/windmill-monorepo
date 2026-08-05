// Ink — what an opened echo is made of, wherever it opens.
//
// Not a card. A mono date hung in the left margin, the older words in lamp ink at reading size, and
// the canvas stays flat: no border, no fill, no glow, no shadow. Tonight is cool --text-primary;
// anything older is --lamp-200, and that difference is the only signal the surface uses.
//
// The margin does the labelling, so the passage itself is never interrupted by chrome. Where a free
// reader's passage stops, nothing is blurred or faded — the sentence ends mid-clause and the words it
// held back are counted out loud, because a blur pretends the text is there and unreadable while a
// stated count is simply true.

import React, { useCallback, useEffect, useState } from 'react';
import { distanceStamp, proseDayMonth, stampCompact, stampStacked } from './echoDates.js';

// One older passage. `dim` is the set's opacity ladder — newest reads first, and nothing is ever
// dimmed past legibility.
export function InkRow({ match, triggerDay, onOpen, dim = 1, size = 'page' }) {
  const { head, year } = stampStacked(match.day);
  return (
    <button
      type="button"
      className={`je-ink-row je-ink-${size}`}
      data-je-match={match.day}
      style={dim === 1 ? undefined : { opacity: dim }}
      onClick={onOpen}
    >
      <span className="je-ink-margin">
        <span>{head}</span>
        <span>{year}</span>
        <span className="je-ink-distance">{distanceStamp(match.day, triggerDay)}</span>
      </span>
      <span className="je-ink-body">
        <span className="je-ink-passage">{match.text}</span>
        <Provenance match={match} />
        {match.withheldWords > 0 && (
          <span className="je-ink-withheld">{match.withheldWords} MORE WORDS</span>
        )}
      </span>
    </button>
  );
}

// The design labels a passage with date and distance and nothing else, which leaves a page you copied
// out of a book indistinguishable from a page you thought. Presence is not the harm; misattribution
// is — so a passage that isn't the writer's own says so, quietly, under the words it belongs to.
function Provenance({ match }) {
  if (match.isSelf === false) return <span className="je-ink-note">something you copied down</span>;
  if (match.source === 'spoken') return <span className="je-ink-note">from your voice note</span>;
  return null;
}

// Everything else found, as one run of dates. Their existence and their age are true and checkable,
// and every one is a page you can stand on — which is what lets the tab carry a count at all.
export function InkDates({ matches, onOpen, size = 'page' }) {
  if (!matches.length) return null;
  return (
    <div className={`je-ink-row je-ink-${size}`}>
      <span className="je-ink-margin je-ink-margin-quiet">
        <span>{matches.length}</span>
        <span>MORE</span>
      </span>
      <span className="je-ink-run">
        {matches.map((match, index) => (
          <React.Fragment key={match.day}>
            {index > 0 && <span aria-hidden="true"> · </span>}
            <button type="button" className="je-ink-date" data-je-match={match.day} onClick={() => onOpen(match)}>
              {stampCompact(match.day)}
            </button>
          </React.Fragment>
        ))}
      </span>
    </div>
  );
}

// The older page is one scroll away and always has been. Naming it costs a few conversions and buys
// the right to cut at all — so it is stated on every surface that cuts.
export function FreePath({ match }) {
  return (
    <p className="je-free-path">
      The {proseDayMonth(match.day)} page is yours already — scroll up to it any time, free.
    </p>
  );
}

// What is still below the fold, counted rather than guessed — and "Not useful", which is always
// there and never asks why: no reason picker, no confirm, nothing counting declines.
export function InkFooter({ echoes, page }) {
  const [unread, setUnread] = useState(0);
  const scroller = echoes.canvas?.scroller ?? null;

  // Every match is one element on screen, whether it opened as a passage or sits in the run of
  // dates, so the number below the fold is a count of things and not an estimate of rows. A match
  // that has BEGUN is one you can see — only the ones that haven't started yet are still to come.
  const measure = useCallback(() => {
    if (!scroller) return;
    const fold = scroller.getBoundingClientRect().bottom;
    const below = [...scroller.querySelectorAll('.je-ink [data-je-match]')]
      .filter((node) => node.getBoundingClientRect().top > fold - 1);
    setUnread(below.length);
  }, [scroller]);

  useEffect(() => {
    measure();
    scroller?.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      scroller?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [measure, scroller, page]);

  return (
    <div className="je-ink-foot">
      <span className="je-ink-more">{unread > 0 ? `SCROLL FOR ${unread} MORE` : ''}</span>
      <button type="button" className="je-not-useful" onClick={() => echoes.retireEcho(page.day)}>
        Not useful
      </button>
    </div>
  );
}
