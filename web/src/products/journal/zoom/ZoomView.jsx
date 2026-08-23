// This week as a small arc, then every month as a row of day cells; tapping a day flies the canvas there.
// Read-only, over the account's pages and this device's (pageStore.js `corpus`). A year it could not read
// says so rather than drawing a grid of empty squares.

import React, { useEffect, useMemo, useState } from 'react';
import { corpus } from '../pageStore.js';
import { useToday } from '../usePages.js';
import { buildYear } from './yearGrid.js';
import { weekReadout } from './weekReadout.js';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function cellColor(day) {
  if (!day.written) return 'transparent';
  return day.mood ? `var(--mood-${day.mood})` : 'color-mix(in srgb, var(--lamp-400) 55%, transparent)';
}

function dow(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

export function ZoomView({ onClose, onPick, account = null }) {
  const [read, setRead] = useState(null);
  const pages = read?.pages ?? null;
  const today = useToday();

  useEffect(() => {
    let cancelled = false;
    corpus({ account }).then((loaded) => { if (!cancelled) setRead(loaded); });
    return () => { cancelled = true; };
  }, [account]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const months = useMemo(() => (pages ? buildYear(pages) : []), [pages]);
  const week = useMemo(() => (pages ? weekReadout(pages, today) : null), [pages, today]);

  return (
    <div className="journal-zoom" role="dialog" aria-label="Zoom out">
      <div className="journal-zoom-head">
        <span className="journal-zoom-title">Your months</span>
        <button type="button" className="journal-zoom-close" onClick={onClose} aria-label="Back to today">Back to today</button>
      </div>

      {week && (
        <section className="journal-week" aria-label="This week">
          <div className="journal-week-count">
            <strong>{week.written}</strong> of 7 days · {week.totalWords} {week.totalWords === 1 ? 'word' : 'words'}
          </div>
          <div className="journal-week-arc">
            {week.days.map((day) => (
              <div key={day.date} className="journal-week-day">
                <span className="journal-week-mood" style={{ background: cellColor(day) }} />
                <span className="journal-week-energy">
                  {[1, 2, 3].map((step) => (
                    <span key={step} className={'journal-week-bar' + (day.energy && step <= day.energy ? ' is-on' : '')} />
                  ))}
                </span>
                <span className="journal-week-dow">{dow(day.date)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {read?.source === 'failed' && (
        <p className="journal-zoom-unread">
          Couldn’t reach your journal — these are only the days on this device.
        </p>
      )}

      <div className="journal-zoom-grid">
        {pages === null && <p className="journal-zoom-loading">drawing your year…</p>}
        {months.map((month) => (
          <div key={month.key} className="journal-zoom-month">
            <span className="journal-zoom-mlabel">{MONTHS[month.month - 1]}{month.month === 1 ? ` ’${String(month.year).slice(2)}` : ''}</span>
            <div className="journal-zoom-days">
              {month.days.map((day) => (
                <button
                  key={day.date}
                  type="button"
                  className={'journal-zoom-cell' + (day.written ? ' is-written' : '') + (day.date === today ? ' is-today' : '')}
                  style={{ background: cellColor(day) }}
                  onClick={() => onPick(day.date)}
                  aria-label={day.date + (day.written ? '' : ' — nothing written')}
                  title={day.date}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
