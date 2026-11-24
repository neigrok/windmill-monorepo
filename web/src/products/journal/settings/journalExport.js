// One continuous Markdown file, oldest first, of the written pages this browser holds. Scales are written as fractions
// ("mood 4/10"), never words, and at full precision — a zero is an answer and prints; unset omits the line.

import { syncSession } from '../../../platform/sync/session.js';
import { captureError } from '../../../telemetry/sentry.js';
import { track } from '../../../telemetry/beacon.js';
import { isWritten, normalizePage, pagesOf, SCOPE } from '../pages.js';
import { t } from '../i18n/settings/index.js';

export function journalMarkdown(pages) {
  const written = pages.map(normalizePage).filter(isWritten).sort((a, b) => (a.day < b.day ? -1 : 1));
  const blocks = written.map((page) => {
    const scales = [];
    if (page.mood != null) scales.push(t('journal.export.mood', { value: page.mood }));
    if (page.energy != null) scales.push(t('journal.export.energy', { value: page.energy }));
    const lines = [`## ${page.day}`];
    if (scales.length) lines.push(`_${scales.join(' · ')}_`);
    if (page.body.trim()) lines.push(page.body.trim());
    return `${lines.join('\n\n')}\n`;
  });
  return `# ${t('journal.export.title')}\n\n${blocks.join('\n')}`;
}

// The room's written pages. Signed out they are the browser's own; a bound replica first finishes its first pull of the
// journal, so the file holds the account's pages and not only what this browser wrote.
export function exportedPages(engine, waitMs = 30_000) {
  const failure = (reason) => Object.assign(new Error('journal-export-wait'), { reason });
  if (!engine || engine.closed) return Promise.reject(failure('no_replica'));
  const hold = engine.observe(SCOPE);
  const replica = hold.getSnapshot().replica;
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => settle(failure('first_pull_timeout')), waitMs);
    const settle = (error) => {
      clearTimeout(timer);
      unsubscribe();
      try {
        if (error) reject(error);
        else resolve(pagesOf(engine, hold.getSnapshot()).filter(isWritten));
      } catch (thrown) { reject(thrown); }
      finally { hold.release(); }
    };
    const look = () => {
      const snapshot = hold.getSnapshot();
      if (snapshot.replica !== replica) settle(failure('replica_changed'));
      else if (snapshot.firstPullComplete) settle(null);
    };
    unsubscribe = hold.subscribe(look);
    look();
  });
}

export async function buildJournalArchive(engine = syncSession.engine) {
  let pages;
  try { pages = await exportedPages(engine); }
  catch (error) {
    track('journal_export', { outcome: error.reason ?? 'failed' });
    if (!error.reason) captureError('journal', 'journal-export', '', '/app/settings');
    throw error;
  }
  const url = URL.createObjectURL(new Blob([journalMarkdown(pages)], { type: 'text/markdown' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'windmill-journal.md';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  track('journal_export', { outcome: 'ok' });
  return { count: pages.length };
}
