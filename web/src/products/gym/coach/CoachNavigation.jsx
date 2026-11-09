import React from 'react';
import { t } from '../i18n/index.js';
import { NOTES_HREF, THREADS_HREF } from '../log.js';

export function CoachNavigation({ active = null, noteCount = null, narrow = false }) {
  return <>
    {narrow && <nav className="gym-coach-shortcuts" aria-label={t('gym.coach.nav.label')}><a href={NOTES_HREF}>{t('gym.coach.notes')}</a><a href={THREADS_HREF}>{t('gym.coach.nav.threads')}</a><a href="/app/connect">{t('gym.coach.nav.connectTools')}</a></nav>}
    <aside className="gym-coach-side">
    <a href={NOTES_HREF} aria-current={active === 'notes' ? 'page' : undefined}>{t('gym.coach.notes')}<span>{noteCount == null ? t('gym.coach.nav.notesHint') : t('gym.coach.nav.notesCount', { count: noteCount })}</span></a>
    <a href={THREADS_HREF}>{t('gym.coach.nav.threads')}<span>{t('gym.coach.nav.threadsHint')}</span></a>
    <div className="gym-coach-connect"><strong>{t('gym.coach.nav.connectTitle')}</strong><p>{t('gym.coach.nav.connectBody')}</p><a href="/app/connect">{t('gym.coach.nav.connectToolsGo')}</a></div>
    </aside>
  </>;
}
