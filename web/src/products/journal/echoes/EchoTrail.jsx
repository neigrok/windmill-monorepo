// Where you came from. Every hop is a position, so every chip is a URL you can stand on again.

import React from 'react';
import { distanceTrail, stampPlain } from './echoDates.js';

export function EchoTrail({ echoes, current }) {
  if (!echoes.hops.length) return null;
  return (
    <nav className="je-trail" aria-label="How you got here">
      <p className="je-trail-label">HOW YOU GOT HERE</p>
      <div className="je-trail-chips">
        {echoes.hops.map((day, index) => (
          <React.Fragment key={day}>
            {index > 0 && (
              <span className="je-link" aria-hidden="true">
                <span className="je-link-rule" />
                <span className="je-link-label">{distanceTrail(day, echoes.hops[index - 1])}</span>
                <span className="je-link-rule" />
              </span>
            )}
            <button
              type="button"
              className={'je-chip' + (day === current ? ' je-chip-current' : '')}
              onClick={() => echoes.standOn(day)}
              aria-current={day === current ? 'page' : undefined}
            >
              {day === echoes.today ? 'TONIGHT' : stampPlain(day)}
            </button>
          </React.Fragment>
        ))}
      </div>
    </nav>
  );
}

export function BackToTonight({ echoes }) {
  if (!echoes.hops.length) return null;
  return (
    <button type="button" className="je-home" onClick={echoes.backToTonight}>
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 5v14M5 12l7 7 7-7" />
      </svg>
      Back to tonight
    </button>
  );
}
