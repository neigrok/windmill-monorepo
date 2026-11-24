// One continuous Markdown file, oldest first, of the written pages this browser holds. Scales are written as fractions
// ("mood 4/10"), never words, and at full precision — a zero is an answer and prints; unset omits the line.

import { syncSession } from '../../../platform/sync/session.js';
import { captureError } from '../../../telemetry/sentry.js';
import { track as trackEvent } from '../../../telemetry/beacon.js';
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

// The room's written pages, as the room shows them. Signed out they are the browser's own; a bound replica first finishes
// its first pull of the journal, so the file holds the account's pages, with what this browser holds in their day's place.
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

// Reading the pages, writing them as Markdown and handing the file to the browser: an expected wait or a replica gone is
// its outcome alone, and anything else in any step is a failure reported with that step and the error's stack.
export async function buildJournalArchive(engine = syncSession.engine, { track = trackEvent, report = captureError } = {}) {
  let step = 'pages';
  try {
    const pages = await exportedPages(engine);
    step = 'file';
    const file = new Blob([journalMarkdown(pages)], { type: 'text/markdown' });
    step = 'download';
    const url = URL.createObjectURL(file);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'windmill-journal.md';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally { URL.revokeObjectURL(url); }
    track('journal_export', { outcome: 'ok' });
    return { count: pages.length };
  } catch (error) {
    track('journal_export', { outcome: error?.reason ?? 'failed' });
    if (!error?.reason) report('journal', 'journal-export', error?.stack ?? '', '/app/settings', { step });
    throw error;
  }
}
