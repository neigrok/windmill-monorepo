// Settings · Your journal — the export, and the pages this browser could not attribute.

import React, { useState } from 'react';
import { Button } from '../../../design-system';
import { useAuth } from '../../../shell/auth/AuthProvider.jsx';
import { buildJournalArchive } from './journalExport.js';
import { UnclaimedPagesRow } from './UnclaimedPagesRow.jsx';
import { Section, styles } from '../../../shell/settings/Section.jsx';
import { t } from '../i18n/settings/index.js';

export function YourJournalSection() {
  const { account } = useAuth();
  const [phase, setPhase] = useState('idle'); // idle | working | done | error
  const [note, setNote] = useState('');

  const runExport = async () => {
    setPhase('working');
    setNote('');
    try {
      const { count } = await buildJournalArchive();
      setPhase('done');
      setNote(t('journal.settings.exported', { count }));
    } catch {
      setPhase('error');
      setNote(t('journal.settings.exportFailed'));
    }
  };

  return (
    <Section title={t('journal.settings.title')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Button variant="secondary" size="sm" disabled={phase === 'working'} onClick={runExport}>
          {phase === 'working' ? t('journal.settings.preparing') : t('journal.settings.export')}
        </Button>
        <span style={styles.calmLine}>{t('journal.settings.exportNote')}</span>
      </div>
      {note && (
        <p style={{ ...styles.metaText, color: phase === 'error' ? 'var(--color-danger)' : 'var(--accent-olive-600)', marginTop: 6 }}>
          {note}
        </p>
      )}
      <UnclaimedPagesRow account={account?.id ?? null} />
    </Section>
  );
}

export default YourJournalSection;
