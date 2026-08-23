// A product owns its export, the account owns its close, and no product grows a second door that closes it.

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
