// Everything found on a page, listed. Two shapes of the same list: the phone panel you open from the
// card, and the desktop margin panel that sits beside the canvas and follows the scroll.
//
// Nothing here concludes anything. Dated passages, newest at the top and oldest at the bottom, as
// everywhere else in the journal — the reader decides what they mean. The total in the title is only
// ever rendered where every counted match is on screen and tappable; a total over a truncated list
// would be a count of something the reader cannot check.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { OfferBlock } from './OneSheet.jsx';
import {
  distanceAgo, distanceCompact, distanceEarlier, proseDate, stampPlain, stampShort,
} from './echoDates.js';
import { Attribution, Passage } from './PageEchoes.jsx';

const DATES_ON_MARGIN = 2;   // the free margin panel names two, then states how many remain

export function EchoPanel({ echoes, page }) {
  const tonight = page.day === echoes.today;
  const oldest = page.matches[page.matches.length - 1];
  const listRef = useRef(null);
  const [unread, setUnread] = useState(0);   // matches not yet scrolled into view — measured, never guessed

  // What is still below the fold, counted rather than guessed — and the row crossing it fades, so the
  // list looks like what it is: longer than the screen, not finished.
  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const fold = list.getBoundingClientRect().bottom;
    const rows = [...list.querySelectorAll('.je-match')];
    rows.forEach((row) => row.classList.toggle('is-below', row.getBoundingClientRect().bottom > fold + 1));
    setUnread(rows.filter((row) => row.getBoundingClientRect().bottom > fold + 1).length);
  }, []);

  useEffect(() => {
    measure();
    const list = listRef.current;
    list?.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      list?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [measure, page]);

  return (
    <div className="je-panel" role="dialog" aria-label="Echoes on this page">
      <header className="je-panel-head">
        <span className="je-panel-chip">ECHOES · {page.matches.length}</span>
        <button type="button" className="je-panel-close" onClick={echoes.closePanel} aria-label="Back to the page">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div className="je-panel-body" ref={listRef} onScroll={measure}>
        <h2 className="je-panel-title">{page.matches.length} times, back to {proseDate(oldest.day)}</h2>
        <p className="je-panel-sub">
          {tonight ? 'Close to what you wrote tonight.' : `Close to what you wrote on ${proseDate(page.day)}.`}
          {' '}Oldest at the bottom, as everywhere else.
        </p>

        <div className="je-panel-list">
          {page.matches.map((match, index) => (
            <button
              key={match.day}
              type="button"
              className="je-match"
              onClick={() => echoes.walkTo(page.day, match)}
            >
              <span className="je-match-head">
                <span className={'je-match-bar' + (index === 0 ? '' : ' je-match-bar-quiet')} aria-hidden="true" />
                <span className="je-match-date">{stampShort(match.day)}</span>
                <span className="je-match-distance">
                  {tonight ? distanceAgo(match.day, page.day) : distanceEarlier(match.day, page.day)}
                </span>
                <Attribution match={match} />
              </span>
              <span className="je-match-passage">{match.text}</span>
            </button>
          ))}
        </div>
      </div>

      <footer className="je-panel-foot">
        <span className="je-panel-more">{unread > 0 ? `SCROLL FOR ${unread} MORE` : ''}</span>
        <button type="button" className="je-not-useful" onClick={() => echoes.retireEcho(page.day)}>Not useful</button>
      </footer>
    </div>
  );
}

// The desktop margin panel — beside the canvas, never between the writer and the cursor. Same dates,
// same order, one sentence shorter without One.
export function EchoMargin({ echoes, page }) {
  const { verify } = echoes;
  const tonight = page.day === echoes.today;
  const [nearest, ...rest] = page.matches;
  const oldest = page.matches[page.matches.length - 1];
  const listed = page.entitled ? rest : rest.slice(0, DATES_ON_MARGIN);
  const beyond = rest.length - listed.length;
  const showOffer = !page.entitled && !echoes.offerRetired(page.day);

  // The panel quotes a passage, so the passage has to be found in the live page first — the same
  // guard the card runs, on whichever page the scroll has brought this panel beside.
  useEffect(() => { verify(page.day); }, [verify, page.day]);

  return (
    <aside className={'je-margin' + (page.entitled ? '' : ' je-margin-free')} aria-label="Echoes on this page">
      <div className="je-margin-head">
        <span className="je-margin-title">ECHOES</span>
        <span className="je-margin-count">{page.matches.length}</span>
      </div>
      <p className="je-margin-sub">
        {tonight ? 'Close to tonight' : `Close to ${proseDate(page.day)}`}, back to {proseDate(oldest.day)}.
      </p>

      <div className="je-margin-nearest">
        <button type="button" className="je-margin-when" onClick={() => echoes.walkTo(page.day, nearest)}>
          <span className="je-margin-date">{stampPlain(nearest.day)}</span>
          <span className="je-margin-distance">{distanceCompact(nearest.day, page.day)}</span>
        </button>
        <Attribution match={nearest} />
        <Passage match={nearest} entitled={page.entitled} className="je-margin-passage" ruleWidth={34} />
      </div>

      {rest.length > 0 && (
        <div className="je-margin-rest">
          {!page.entitled && (
            <p className="je-rest"><strong>{rest.length} more</strong>, back to {proseDate(oldest.day)}</p>
          )}
          <div className="je-margin-dates">
            {listed.map((match) => (
              <button
                key={match.day}
                type="button"
                className="je-margin-row"
                onClick={() => echoes.walkTo(page.day, match)}
              >
                <span className="je-margin-date">{stampPlain(match.day)}</span>
                <span className="je-margin-distance">{distanceCompact(match.day, page.day)}</span>
              </button>
            ))}
            {beyond > 0 && <p className="je-margin-more">+ {beyond} MORE</p>}
          </div>
        </div>
      )}

      {showOffer && (
        <OfferBlock
          page={page}
          nearest={nearest}
          oldest={oldest}
          stacked
          onBuy={() => echoes.openSheet(page.day)}
          onNotNow={() => echoes.retireOffer(page.day)}
        />
      )}

      {page.entitled && (
        <p className="je-margin-foot">This panel follows the scroll. It never asks you to do anything.</p>
      )}
    </aside>
  );
}
