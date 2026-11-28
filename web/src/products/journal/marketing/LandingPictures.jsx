// The journal's pictures on its landing, each on its own night canvas at any hour, drawn at the stage the shell names:
// tonight's page with an echo under it, the search sheet, a page being written, and a year looked back on. A caret is
// marked to cut, so it is solid again the moment the pointer leaves.

import React from 'react';
import { Search } from 'lucide-react';
import { t } from '../i18n/landing/index.js';
import './landingPictures.css';

function Night({ name, stage, children }) {
  return <div className={`jnNight ${name}`} data-brand="journal" data-theme="dark" data-stage={stage}>{children}</div>;
}

export function NightWindow({ stage }) {
  return (
    <Night name="jnWindow" stage={stage}>
      <div className="jnWindow-page">
        <p className="jnWindow-stamp">{t('journal.landing.night.stamp')}<i /></p>
        <p className="jnWindow-earlier">{t('journal.landing.night.earlier')}</p>
        <p className="jnWindow-tonight">{t('journal.landing.night.tonight')}<span className="jnCursor" data-cut="" /></p>
        <div className="jnWindow-echo">
          <p>{t('journal.landing.night.echo')}</p>
          <p className="jnWindow-date">{t('journal.landing.night.echoDate')}</p>
        </div>
      </div>
    </Night>
  );
}

// The query, three days around the hit, and why the hit matched.
const HITS = [
  { day: t('journal.landing.searchSheet.thu'), line: t('journal.landing.searchSheet.thuLine') },
  { day: t('journal.landing.searchSheet.fri'), line: t('journal.landing.searchSheet.friLine'), why: t('journal.landing.searchSheet.why') },
  { day: t('journal.landing.searchSheet.sat'), line: t('journal.landing.searchSheet.satLine') },
];

export function SearchSheet({ stage }) {
  return (
    <Night name="jnSearch" stage={stage}>
      <div className="jnSearch-sheet">
        <p className="jnSearch-query"><Search size={17} strokeWidth={2} />{t('journal.landing.searchSheet.query')}</p>
        <ul>
          {HITS.map((hit) => (
            <li key={hit.day} className={hit.why ? 'is-hit' : undefined}>
              <span className="jnSearch-day">{hit.day}</span>
              <span>
                <span className="jnSearch-line">{hit.line}</span>
                {hit.why && <span className="jnSearch-why">{hit.why}</span>}
              </span>
            </li>
          ))}
        </ul>
        <p className="jnSearch-foot">{t('journal.landing.searchSheet.foot')}</p>
      </div>
    </Night>
  );
}

export function WriteBeat({ stage }) {
  return (
    <Night name="jnScene" stage={stage}>
      <div className="jnScene-box">
        <p className="jnScene-stamp">{t('journal.landing.write.yesterday')}</p>
        <p className="jnScene-past">{t('journal.landing.write.yesterdayLine')}</p>
        <p className="jnScene-stamp is-today">{t('journal.landing.write.today')}</p>
        <p className="jnScene-now">{t('journal.landing.write.todayLine')}<span className="jnCursor" data-cut="" /></p>
      </div>
    </Night>
  );
}

// Three months pinched down to dots: a lamp step for each day written, hollow for a day nobody wrote.
const YEAR = [
  { month: t('journal.landing.lookBack.may'), days: [5, 4, 0, 6, 4, 0, 0, 4, 2, 5, 4, 0, 6, 5, 4, 2, 0, 4, 5, 4, 6] },
  { month: t('journal.landing.lookBack.jun'), days: [4, 0, 0, 0, 5, 4, 6, 4, 0, 2, 4, 5, 4, 0, 4, 6, 5, 4, 0, 4, 2] },
  { month: t('journal.landing.lookBack.jul'), days: [5, 4, 4, 0, 0, 6, 4, 5, 4, 0, 2, 4, 5, 4, 6, 0, 4, 4, 5, 2, 4] },
];

export function LookBackBeat({ stage }) {
  return (
    <Night name="jnScene" stage={stage}>
      <div className="jnScene-box">
        <p className="jnScene-stamp">{t('journal.landing.lookBack.year')}</p>
        <div className="jnYear">
          {YEAR.map((row) => (
            <p key={row.month}>
              <span>{row.month}</span>
              {row.days.map((step, index) => <i key={index} className={step ? `is-lamp${step}` : undefined} />)}
            </p>
          ))}
        </div>
        <p className="jnScene-legend">{t('journal.landing.lookBack.legend')}</p>
      </div>
    </Night>
  );
}
