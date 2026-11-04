// A product owns its export, the account owns its close, and no product grows a second door that closes it.

import React, { useState } from 'react';
import { Button } from '../../../design-system';
import { buildExportArchive, reportExportFailure } from './exportArchive.js';
import { Section, styles } from '../../../shell/settings/Section.jsx';
import { track } from '../../../telemetry/beacon.js';

const EXPORT_FAILED = "Couldn't build your export just now — try again.";

function exportOutcome(count, total) {
  if (count === total) return 'done';
  return count === 0 ? 'failed' : 'partial';
}

function exportedLine(count, total) {
  if (total === 0) return 'No roadmaps to export yet.';
  if (count < total) return `Exported ${count} of ${total} roadmaps.`;
  return `Exported ${count} roadmap${count === 1 ? '' : 's'}.`;
}

export function YourDataSection() {
  const [exportPhase, setExportPhase] = useState('idle'); // idle | working | done | error
  const [exportNote, setExportNote] = useState('');

  const runExport = async () => {
    setExportPhase('working');
    setExportNote('');
    try {
      const { count, total } = await buildExportArchive();
      const outcome = exportOutcome(count, total);
      track('roadmap_export', { outcome, door: 'settings' });
      setExportPhase(outcome === 'done' ? 'done' : 'error');
      setExportNote(outcome === 'failed' ? EXPORT_FAILED : exportedLine(count, total));
    } catch (error) {
      reportExportFailure('roadmap-export', error);
      track('roadmap_export', { outcome: 'failed', door: 'settings' });
      setExportPhase('error');
      setExportNote(EXPORT_FAILED);
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
