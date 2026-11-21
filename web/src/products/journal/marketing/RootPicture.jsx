// The journal's picture on the brand root: three days of the page with one echo beside it. A still
// composition on the journal's own night canvas, which it keeps on a day page; the shell frames and
// labels it.

import React from 'react';
import { t } from '../i18n/entry/index.js';
import './journalRootPicture.css';

export function JournalPicture() {
  return (
    <div className="jnPicture" data-brand="journal" data-theme="dark">
      <div className="jnPicture-page">
        <p className="jnPicture-day">{t('journal.root.firstDay')}<i /></p>
        <p className="jnPicture-text">{t('journal.root.firstPage')}</p>
        <p className="jnPicture-day">{t('journal.root.secondDay')}<i /></p>
        <p className="jnPicture-text">{t('journal.root.secondPage')}</p>
        <p className="jnPicture-day jnPicture-day--today">{t('journal.root.today')}</p>
        <p className="jnPicture-text">{t('journal.root.todayFirst')}</p>
        <p className="jnPicture-text">{t('journal.root.todaySecond')}</p>
        <p className="jnPicture-text">{t('journal.root.todayThird')}</p>
      </div>
      <span className="jnPicture-rule" />
      <div className="jnPicture-echo">
        <span className="jnPicture-kicker">{t('journal.root.echo')}</span>
        <b className="jnPicture-echoDay">{t('journal.root.echoDay')}</b>
        <p className="jnPicture-passage">{t('journal.root.echoPassage')}</p>
        <span className="jnPicture-source">{t('journal.root.echoSource')}</span>
        <span className="jnPicture-go">{t('journal.root.echoGo')}</span>
      </div>
    </div>
  );
}
