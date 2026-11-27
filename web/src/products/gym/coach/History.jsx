import React from 'react';
import { ChevronLeft, ChevronRight, MessageSquarePlus, Trash2 } from 'lucide-react';
import { Id } from '../../../platform/domain-kit/entities.js';
import { CoachThread } from '../domain/coach/conversation.js';
import { t } from '../i18n/index.js';
import { COACH_HREF, daysAgo, shortDayLabel, threadHref } from '../log.js';
import { useDomainRead } from '../useDomainRead.js';
import { historyRows } from './conversations.js';

// The day a conversation was last asked in: today, yesterday, or its date.
export function dayWords(ms, now = Date.now()) {
  const days = daysAgo(ms, now);
  if (days <= 0) return t('gym.coach.history.today');
  if (days === 1) return t('gym.coach.history.yesterday');
  return shortDayLabel(ms);
}

// History's rows, less the conversations whose delete the room is holding or has sent.
export function useHistoryRows(log) {
  const history = useDomainRead(historyRows, []);
  const hidden = log.hidden('thread');
  const gone = log.gone('thread');
  return { ready: history.phase === 'ready', rows: (history.data ?? []).filter((row) => !hidden.has(row.id) && !gone.has(row.id)) };
}

// A conversation's delete, held and undone through the room's Undo toast, then the records' delete. A conversation whose
// turn is running on this page stays.
export function deleteConversation(log, turns, id, open) {
  log.withhold({ kind: 'thread', id, line: t('gym.threads.deleted'), detail: t('gym.threads.deleteDetail'),
    send: () => turns.deleteConversation(new Id(id, CoachThread)),
    refused: () => log.say(t('gym.coach.history.deleteRefused')) });
  if (open) window.location.hash = COACH_HREF;
}

// What a row says under its title: what its last turn made, or the first words of its last answer (08.4).
function lineOf(line) {
  if (line === null) return null;
  if (line.kind === 'created') return t('gym.coach.history.created', { count: line.count });
  if (line.kind === 'proposal') return t('gym.coach.history.proposal', { routine: line.routine, count: line.count });
  if (line.kind === 'workout') return t('gym.coach.history.workout', { count: line.count });
  return line.text;
}

// History (08W.2): one list with the phones, newest first, the open conversation marked. A row's delete is a hover or
// focus button on a wide screen; on a narrow one the list is links alone, and a conversation's delete is in its More.
export function HistoryList({ rows, current = null, onDelete, ready, page = false }) {
  return <section className={`gym-coach-history${page ? ' is-page' : ''}`} aria-labelledby="gym-coach-history-title">
    <header className="gym-coach-history-head">
      {page && <a className="gym-coach-history-back" href={COACH_HREF} aria-label={t('gym.coach.title')}><ChevronLeft size={22} aria-hidden="true" /></a>}
      <h2 id="gym-coach-history-title" className={page ? 'gym-title' : undefined}>{t('gym.threads.title')}</h2>
      <a className="gym-coach-new-chat" href={COACH_HREF} aria-label={t('gym.coach.newChat')}><MessageSquarePlus size={22} aria-hidden="true" /></a>
    </header>
    {ready && rows.length === 0 && <p className="gym-coach-history-empty">{t('gym.coach.history.empty')}</p>}
    <nav aria-labelledby="gym-coach-history-title">
      <ul className="gym-coach-history-rows">
        {rows.map((row) => {
          const line = lineOf(row.line);
          return <li key={row.id} className={row.id === current ? 'is-current' : undefined}>
            <a href={threadHref(row.id)} aria-current={row.id === current ? 'page' : undefined}>
              <span className="gym-coach-history-title">{row.title}</span>
              <span className="gym-coach-history-when">{dayWords(row.at)}</span>
              {line && <span className="gym-coach-history-line">{line}</span>}
              {page && <ChevronRight className="gym-coach-history-go" size={18} aria-hidden="true" />}
            </a>
            {!page && <button type="button" className="gym-coach-history-delete" aria-label={t('gym.coach.history.delete')} onClick={() => onDelete(row.id)}><Trash2 size={18} aria-hidden="true" /></button>}
          </li>;
        })}
      </ul>
    </nav>
  </section>;
}

// History as its own page on a narrow screen (08W.2 · 390).
export function HistoryPage({ log }) {
  const { rows, ready } = useHistoryRows(log);
  return <HistoryList rows={rows} ready={ready} page />;
}
