// This week as a small arc, then every month as a row of day cells; tapping a day flies the canvas there.
// Read-only, over the account's pages and this device's (pages.js `corpus`). A year it could not read
// says so rather than drawing a grid of empty squares.

import React, { useEffect, useMemo } from 'react';
import { corpus, SCOPE } from '../pages.js';
import { useSyncRecords } from '../../../platform/sync/react.js';
import { useToday } from '../usePages.js';
import { buildYear } from './yearGrid.js';
import { weekReadout } from './weekReadout.js';
import { energyBars, moodBand } from '../scaleBands.js';
import { SHORT_MONTHS } from '../echoes/echoDates.js';
import { t } from '../i18n/index.js';

const WEEKDAYS = [
  t('journal.date.weekdayInitial.sun'), t('journal.date.weekdayInitial.mon'), t('journal.date.weekdayInitial.tue'),
  t('journal.date.weekdayInitial.wed'), t('journal.date.weekdayInitial.thu'), t('journal.date.weekdayInitial.fri'),
  t('journal.date.weekdayInitial.sat'),
];

// Eleven hues in a 15px cell is not a design, it is a hope: the grid reads the five bands.
function cellColor(day) {
  if (!day.written) return 'transparent';
  if (day.mood == null) return 'color-mix(in srgb, var(--lamp-400) 55%, transparent)';
  return `var(--mood-${moodBand(day.mood)})`;
}

function dow(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

export function ZoomView({ onClose, onPick, account = null }) {
  const records = useSyncRecords(SCOPE);
  const read = useMemo(() => corpus({ account }), [account, records]);
  const { pages } = read;
  const today = useToday();

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const months = useMemo(() => buildYear(pages), [pages]);
  const week = useMemo(() => weekReadout(pages, today), [pages, today]);

  return (
    <div className="journal-zoom" role="dialog" aria-label={t('journal.zoom.title')}>
      <div className="journal-zoom-head">
        <span className="journal-zoom-title">{t('journal.zoom.heading')}</span>
        <button type="button" className="journal-zoom-close" onClick={onClose} aria-label={t('journal.zoom.back')}>{t('journal.zoom.back')}</button>
      </div>

      {week && (
        <section className="journal-week" aria-label={t('journal.zoom.week')}>
          <div className="journal-week-count">
            {t('journal.zoom.weekCount', { written: <strong>{week.written}</strong>, count: week.totalWords })}
          </div>
          <div className="journal-week-arc">
            {week.days.map((day) => (
              <div key={day.date} className="journal-week-day">
                <span className="journal-week-mood" style={{ background: cellColor(day) }} />
                <span className={'journal-week-energy' + (day.energy != null ? ' is-set' : '')}>
                  {[1, 2, 3].map((step) => (
                    <span key={step} className={'journal-week-bar' + (step <= energyBars(day.energy) ? ' is-on' : '')} />
                  ))}
                </span>
                <span className="journal-week-dow">{dow(day.date)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {read.source === 'failed' && (
        <p className="journal-zoom-unread">{t('journal.zoom.unread')}</p>
      )}

      <div className="journal-zoom-grid">
        {months.map((month) => (
          <div key={month.key} className="journal-zoom-month">
            <span className="journal-zoom-mlabel">
              {month.month === 1
                ? t('journal.zoom.monthWithYear', { month: SHORT_MONTHS[0], year: String(month.year).slice(2) })
                : SHORT_MONTHS[month.month - 1]}
            </span>
            <div className="journal-zoom-days">
              {month.days.map((day) => (
                <button
                  key={day.date}
                  type="button"
                  className={'journal-zoom-cell' + (day.written ? ' is-written' : '') + (day.date === today ? ' is-today' : '')}
                  style={{ background: cellColor(day) }}
                  onClick={() => onPick(day.date)}
                  aria-label={day.written ? day.date : t('journal.zoom.nothingWritten', { day: day.date })}
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
