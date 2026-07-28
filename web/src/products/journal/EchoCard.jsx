// An echo, opened. It reconstructs the older line the way search results do — by slicing the match
// span out of the match day's own body (the server never sends a snippet; the quote is a presence, not
// a payload) — and offers two moves: read it (fly the canvas to that passage, lit) or let it fade
// (dismiss it for good). No similarity, no percentage, no "because": an echo is felt, not scored.

import React, { useEffect, useState } from 'react';
import { journalApi } from './journalApi.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Echo matches are usually months or years back, so the year earns its place here (unlike search).
function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function EchoCard({ echo, onClose, onRead, onDismiss }) {
  const [line, setLine] = useState(null);

  useEffect(() => {
    let cancelled = false;
    journalApi.page(echo.matchDay)
      .then((page) => {
        if (cancelled) return;
        const body = page?.body || '';
        const [lo, hi] = echo.matchSpan;
        setLine(body.slice(lo, hi).trim() || body.trim());
      })
      .catch(() => { if (!cancelled) setLine(''); });
    return () => { cancelled = true; };
  }, [echo]);

  return (
    <div
      className="journal-echo"
      role="dialog"
      aria-label="An echo"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="journal-echo-panel">
        <p className="journal-echo-lead">You wrote something like this before</p>
        <blockquote className="journal-echo-quote">
          {line === null && <span className="journal-echo-loading">finding it…</span>}
          {line === '' && <span className="journal-echo-loading">that page is gone now</span>}
          {line && `“${line}”`}
        </blockquote>
        <p className="journal-echo-when">{longDate(echo.matchDay)}</p>
        <div className="journal-echo-actions">
          <button type="button" className="journal-echo-read" onClick={() => onRead(echo)}>Read it</button>
          <button type="button" className="journal-echo-fade" onClick={() => onDismiss(echo.triggerDay)}>Let it fade</button>
        </div>
      </div>
    </div>
  );
}
