// Ink — what an opened echo is made of, wherever it opens: a mono date in the margin, the older words in
// lamp ink. A cut passage is counted out loud, never blurred. The reader's answer lives on the server.

import React, { useCallback, useEffect, useState } from 'react';
import { distanceStamp, proseDayMonth, stampCompact, stampStacked } from './echoDates.js';

// One older passage. `dim` is worn by the date and the words, never by the row, so the answer below reads
// the same on the ninth passage as on the first. `data-je-match` stays on the row: the footer counts it.
export function InkRow({ match, triggerDay, onOpen, onUseful, onNotUseful, dim = 1, size = 'page' }) {
  const { head, year } = stampStacked(match.day);
  const faded = dim === 1 ? undefined : { opacity: dim };
  return (
    <div className={`je-ink-row je-ink-${size}`} data-je-match={match.day}>
      <span className="je-ink-margin" style={faded}>
        <span>{head}</span>
        <span>{year}</span>
        <span className="je-ink-distance">{distanceStamp(match.day, triggerDay)}</span>
      </span>
      <span className="je-ink-body">
        <button type="button" className="je-ink-open" style={faded} onClick={onOpen}>
          <span className="je-ink-passage">{match.text}</span>
          <Provenance match={match} />
          {match.withheldWords > 0 && (
            <span className="je-ink-withheld">{match.withheldWords} MORE WORDS</span>
          )}
        </button>
        {onUseful && <Verdict match={match} onUseful={onUseful} onNotUseful={onNotUseful} />}
      </span>
    </div>
  );
}

// Asked of the passage, not the page. "Not useful" takes it off the page and asks nothing further.
function Verdict({ match, onUseful, onNotUseful }) {
  return (
    <span className="je-verdict">
      <button
        type="button"
        className={'je-verdict-mark' + (match.useful ? ' je-verdict-held' : '')}
        aria-pressed={Boolean(match.useful)}
        onClick={onUseful}
      >
        Useful
      </button>
      <button type="button" className="je-verdict-mark" onClick={onNotUseful}>
        Not useful
      </button>
    </span>
  );
}

// A passage that isn't the writer's own says so.
function Provenance({ match }) {
  if (match.isSelf === false) return <span className="je-ink-note">something you copied down</span>;
  if (match.source === 'spoken') return <span className="je-ink-note">from your voice note</span>;
  return null;
}

// Everything else found, as one run of dates.
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

// Stated on every surface that cuts: the older page is one scroll away.
export function FreePath({ match }) {
  return (
    <p className="je-free-path">
      The {proseDayMonth(match.day)} page is yours already — scroll up to it any time, free.
    </p>
  );
}

// What is still below the fold, counted rather than guessed.
export function InkFooter({ echoes, page }) {
  const [unread, setUnread] = useState(0);
  const scroller = echoes.canvas?.scroller ?? null;

  // Counts elements rather than estimating rows: only matches that have not started are still to come.
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
