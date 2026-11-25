// Settings · Your journal — the export of the pages the replica this tab draws holds, and the pages this browser could not
// attribute. The section counts what the export would hold as soon as the replica can say: at once signed out, where the
// pages are the browser's own, and on a bound replica once its first pull of the journal ends. With none, it offers none.

import React, { useState } from 'react';
import { Button } from '../../../design-system';
import { useAuth } from '../../../shell/auth/AuthProvider.jsx';
import { useSyncRecords, useSyncReplica } from '../../../platform/sync/react.js';
import { SCOPE } from '../pages.js';
import { buildJournalArchive, exportablePages } from './journalExport.js';
import { UnclaimedPagesRow } from './UnclaimedPagesRow.jsx';
import { Section, styles } from '../../../shell/settings/Section.jsx';
import { t } from '../i18n/settings/index.js';

export function YourJournalSection() {
  const { account } = useAuth();
  const replica = useSyncReplica();
  const records = useSyncRecords(SCOPE);
  const [attempt, setAttempt] = useState({ phase: 'idle' }); // idle | working | done, with its count and file | failed
  const engine = replica?.engine ?? null;
  const written = engine && records.loaded && records.firstPullComplete ? exportablePages(engine, records).length : null;
  // The file holds the browser's own pages where the replica is the anon one; a bound replica's, a lapsed seat's included,
  // are the account's.
  const browsersOwn = replica ? replica.state === 'anon' : !account;
  const working = attempt.phase === 'working';

  const runExport = async () => {
    setAttempt({ phase: 'working' });
    try {
      setAttempt({ phase: 'done', ...(await buildJournalArchive(engine, account ? 'signed_in' : 'signed_out')) });
    } catch {
      setAttempt({ phase: 'failed' });
    }
  };

  return (
    <Section title={t('journal.settings.title')}>
      {written === 0 && !working ? (
        <p style={styles.calmLine}>{t('journal.settings.nothingToExport')}</p>
      ) : (
        <>
          <div style={styles.actionRow}>
            <Button variant="secondary" size="sm" disabled={working} ariaBusy={working} onClick={runExport}>
              {working ? t('journal.settings.preparing') : t('journal.settings.export')}
            </Button>
            <span style={styles.actionLine}>{browsersOwn ? t('journal.settings.exportNoteHere') : t('journal.settings.exportNote')}</span>
          </div>
          <div aria-live="polite">
            {attempt.phase === 'done' && attempt.count > 0 && (
              <p style={{ ...outcome, color: 'var(--color-success)' }}>{t('journal.settings.exported', { count: attempt.count, file: attempt.file })}</p>
            )}
            {attempt.phase === 'failed' && <p style={{ ...outcome, color: 'var(--color-danger)' }}>{t('journal.settings.exportFailed')}</p>}
          </div>
        </>
      )}
      <UnclaimedPagesRow account={account?.id ?? null} />
    </Section>
  );
}

export default YourJournalSection;

const outcome = { ...styles.metaText, margin: '10px 0 0', animation: 'wm-fade-in-up var(--duration-fast) var(--ease-soft)' };
