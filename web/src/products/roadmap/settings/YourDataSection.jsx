// Settings · Your roadmaps — the export, and nothing else. It zips one Markdown file per tree in
// F3's grammar, the same format the composer pastes back, so it round-trips.
//
// CLOSING THE ACCOUNT USED TO LIVE HERE TOO, and that was the bug: an account holds journal pages
// and gym sessions as well as trees, so a delete screen inside the roadmap described one product's
// data while closing all three. It moved to shell/settings/CloseAccountSection.jsx on 2026-08-07 —
// a product owns its export, the account owns its close, and no product may grow a second door
// that closes it.

import React, { useState } from 'react';
import { Button } from '../../../design-system';
import { buildExportArchive } from './buildExportArchive.js';
import { Section, styles } from '../../../shell/settings/Section.jsx';

export function YourDataSection() {
  const [exportPhase, setExportPhase] = useState('idle'); // idle | working | done | error
  const [exportNote, setExportNote] = useState('');

  const runExport = async () => {
    setExportPhase('working');
    setExportNote('');
    try {
      const { count } = await buildExportArchive();
      setExportPhase('done');
      setExportNote(count === 0 ? 'No roadmaps to export yet.' : `Exported ${count} roadmap${count === 1 ? '' : 's'}.`);
    } catch {
      setExportPhase('error');
      setExportNote("Couldn't build your export just now — try again.");
    }
  };

  return (
    <Section title="Your roadmaps">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Button variant="secondary" size="sm" disabled={exportPhase === 'working'} onClick={runExport}>
          {exportPhase === 'working' ? 'Preparing…' : 'Export my trees'}
        </Button>
        <span style={styles.calmLine}>A .zip of Markdown — one file per tree. Paste any of them back to replant it.</span>
      </div>
      {exportNote && (
        <p style={{ ...styles.metaText, color: exportPhase === 'error' ? 'var(--color-danger)' : 'var(--accent-olive-600)', marginTop: 6 }}>
          {exportNote}
        </p>
      )}
    </Section>
  );
}

export default YourDataSection;
