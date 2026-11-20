// A product owns its export, the account owns its close, and no product grows a second door that closes it.

import React, { useState } from 'react';
import { Button } from '../../../design-system';
import { buildExportArchive, exportOutcome, readAccountRoadmaps, readReplicaRoadmaps, reportExportFailure } from './exportArchive.js';
import { ROOM_READS_REPLICA } from '../replicaRoom.js';
import { Section, styles } from '../../../shell/settings/Section.jsx';
import { track } from '../../../telemetry/beacon.js';
import { t } from '../i18n/settings/index.js';

const EXPORT_FAILED = t('roadmap.export.failed');

// The export reads the device's copy where the room does (replicaRoom.js).
const READ_ROADMAPS = ROOM_READS_REPLICA ? readReplicaRoadmaps : readAccountRoadmaps;

function exportedLine(count, total) {
  if (total === 0) return t('roadmap.export.nothing');
  if (count < total) return t('roadmap.export.partial', { count, total });
  return t('roadmap.export.done', { count });
}

export function YourDataSection() {
  const [exportPhase, setExportPhase] = useState('idle'); // idle | working | done | error
  const [exportNote, setExportNote] = useState('');

  const runExport = async () => {
    setExportPhase('working');
    setExportNote('');
    try {
      const archive = await buildExportArchive(READ_ROADMAPS);
      const outcome = exportOutcome(archive);
      track('roadmap_export', { outcome, door: 'settings' });
      setExportPhase(outcome === 'done' ? 'done' : 'error');
      setExportNote(outcome === 'failed' || outcome === 'unopened' ? EXPORT_FAILED : exportedLine(archive.count, archive.total));
    } catch (error) {
      reportExportFailure('roadmap-export', error);
      track('roadmap_export', { outcome: 'failed', door: 'settings' });
      setExportPhase('error');
      setExportNote(EXPORT_FAILED);
    }
  };

  return (
    <Section title={t('roadmap.export.title')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Button variant="secondary" size="sm" disabled={exportPhase === 'working'} onClick={runExport}>
          {exportPhase === 'working' ? t('roadmap.export.preparing') : t('roadmap.export.action')}
        </Button>
        <span style={styles.calmLine}>{t('roadmap.export.detail')}</span>
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
