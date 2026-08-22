// Settings · Your journal — the export, and the pages this browser could not attribute. The export
// route it calls has been live since the product shipped; until this section there was no way to
// reach it from inside the product, so a writer could not get their own pages out. A product owns
// its export; the account owns its close.

import React, { useState } from 'react';
import { Button } from '../../../design-system';
import { useAuth } from '../../../shell/auth/AuthProvider.jsx';
import { buildJournalArchive } from './journalExport.js';
import { UnclaimedPagesRow } from './UnclaimedPagesRow.jsx';
import { Section, styles } from '../../../shell/settings/Section.jsx';

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
      setNote(count === 0 ? 'No pages to export yet.' : `Exported ${count} page${count === 1 ? '' : 's'}.`);
    } catch {
      setPhase('error');
      setNote("Couldn't build your export just now — try again.");
    }
  };

  return (
    <Section title="Your journal">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Button variant="secondary" size="sm" disabled={phase === 'working'} onClick={runExport}>
          {phase === 'working' ? 'Preparing…' : 'Export my pages'}
        </Button>
        <span style={styles.calmLine}>One Markdown file — every page you have written, oldest first.</span>
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
