// One continuous Markdown file, oldest first, of the written pages this browser holds. Scales are written as fractions
// ("mood 4/10"), never words, and at full precision — a zero is an answer and prints; unset omits the line.

import { captureError } from '../../../telemetry/sentry.js';
import { track as trackEvent } from '../../../telemetry/beacon.js';
import { isWritten, normalizePage, pagesOf, SCOPE } from '../pages.js';
import { t } from '../i18n/settings/index.js';

const FILE_NAME = 'windmill-journal.md';

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

// What the export holds of a snapshot of the journal: the room's written pages, as the room shows them.
export const exportablePages = (engine, snapshot) => pagesOf(engine, snapshot).filter(isWritten);

// An export's own wait, which ends it as an outcome of its own and never as a failure: `no_replica` where the browser holds
// no open replica, `first_pull_timeout` where a bound replica's first pull of the journal did not end within the wait, and
// `replica_changed` where the account changed while it waited. Only `exportedPages` makes one, so these are every expected
// outcome; any other error, a domain kit's that carries a reason of its own included, is a failure.
class ExportWait extends Error {
  constructor(reason) {
    super('journal-export-wait');
    this.reason = reason;
  }
}

// A failure of the export, or of the count Settings shows before it, under its static operation with the step it met and
// the error's stack, never its message.
export function reportExportFailure(step, error, report = captureError) {
  report('journal', 'journal-export', error?.stack ?? '', '/app/settings', { step });
}

// The room's written pages, as the room shows them. Signed out they are the browser's own; a bound replica first finishes
// its first pull of the journal, so the file holds the account's pages, with what this browser holds in their day's place.
export function exportedPages(engine, waitMs = 30_000) {
  if (!engine || engine.closed) return Promise.reject(new ExportWait('no_replica'));
  const hold = engine.observe(SCOPE);
  const replica = hold.getSnapshot().replica;
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => settle(new ExportWait('first_pull_timeout')), waitMs);
    const settle = (error) => {
      clearTimeout(timer);
      unsubscribe();
      try {
        if (error) reject(error);
        else resolve(exportablePages(engine, hold.getSnapshot()));
      } catch (thrown) { reject(thrown); }
      finally { hold.release(); }
    };
    const look = () => {
      const snapshot = hold.getSnapshot();
      if (snapshot.replica !== replica) settle(new ExportWait('replica_changed'));
      else if (snapshot.firstPullComplete) settle(null);
    };
    unsubscribe = hold.subscribe(look);
    look();
  });
}

// Reading the pages, writing them as Markdown and handing the file to the browser, told for the replica it reads (`seat`,
// `signed_in` or `signed_out`): no written page is the outcome `empty` and downloads nothing, an export's own wait is its
// outcome alone, and anything else in any step is a failure reported with that step and the error's stack.
export async function buildJournalArchive(engine, seat, { track = trackEvent, report = captureError } = {}) {
  let step = 'pages';
  try {
    const pages = await exportedPages(engine);
    if (pages.length === 0) {
      track('journal_export', { outcome: 'empty', seat });
      return { count: 0, file: null };
    }
    step = 'file';
    const file = new Blob([journalMarkdown(pages)], { type: 'text/markdown' });
    step = 'download';
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    try {
      anchor.href = url;
      anchor.download = FILE_NAME;
      document.body.appendChild(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      URL.revokeObjectURL(url);
    }
    track('journal_export', { outcome: 'ok', seat });
    return { count: pages.length, file: FILE_NAME };
  } catch (error) {
    const waited = error instanceof ExportWait;
    track('journal_export', { outcome: waited ? error.reason : 'failed', seat });
    if (!waited) reportExportFailure(step, error, report);
    throw error;
  }
}
