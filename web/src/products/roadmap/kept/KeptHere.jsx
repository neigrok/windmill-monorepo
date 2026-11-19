// §6 Kept here beside every room (flow 49.06): roadmap's notices read through the engine in every scope, offered as the
// account menu's row while the list holds a change, and the list itself while the person has it open. Each change that
// cannot land is told to the intake once on this browser; a notice no rule of §6 lists is a failure, reported by its code.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBoundary } from '../../../design-system';
import { useAccountRowOffer } from '../../../shell/ProductSessions.jsx';
import { useSyncEngine, useSyncNotices } from '../../../platform/sync/react.js';
import { track } from '../../../telemetry/beacon.js';
import { countBucket } from '../board/acts.js';
import { localStorageOrNothing } from '../persistence/browserStorage.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { t } from '../i18n/index.js';
import { keptChanges } from './KeptChanges.js';
import { KeptList, listed } from './KeptList.jsx';

const NOTHING_KEPT = Object.freeze({ kept: [], unexpected: [] });
// The notices this browser has told the intake of, the newest 200; a storage error risks telling one twice, never a failure.
const TOLD = 'windmill:roadmap:kept-told';
const reportedCodes = new Set();

export function KeptHere() {
  const engine = useSyncEngine();
  const { notices } = useSyncNotices('roadmap');
  const [opened, setOpened] = useState(0);
  const [open, setOpen] = useState(false);
  const read = useMemo(() => engine ? keptChanges(notices, engine.registry) : NOTHING_KEPT, [engine, notices]);
  const shown = listed(read.kept).length;
  const counted = useRef(shown);
  counted.current = shown;

  useEffect(() => {
    if (read.kept.length === 0) return;
    const storage = localStorageOrNothing();
    let told = [];
    try { told = JSON.parse(storage.getItem(TOLD) ?? '[]'); } catch { told = []; }
    if (!Array.isArray(told)) told = [];
    const fresh = read.kept.filter((change) => !told.includes(change.id));
    if (fresh.length === 0) return;
    for (const change of fresh) track('roadmap_write_cannot_land', { reason: change.reason });
    try { storage.setItem(TOLD, JSON.stringify([...told, ...fresh.map((change) => change.id)].slice(-200))); } catch { /* told again next time */ }
  }, [read]);

  useEffect(() => {
    for (const { code } of read.unexpected) {
      if (reportedCodes.has(code)) continue;
      reportedCodes.add(code);
      reportRoadmapFailure('roadmap-kept-unexpected', new Error('A notice no rule of the list lists'), { code });
    }
  }, [read]);

  const openList = useCallback(() => {
    track('roadmap_kept', { step: 'open', count: countBucket(counted.current) });
    setOpened((count) => count + 1);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const row = useMemo(() => shown > 0 ? { label: t('roadmap.kept.name'), count: shown, onSelect: openList } : null, [shown, openList]);
  useAccountRowOffer(row);

  if (!open || !engine) return null;
  return (
    <ErrorBoundary key={opened} fallback={null} onCrash={(error) => { reportRoadmapFailure('roadmap-kept', error); close(); }}>
      <KeptList engine={engine} notices={notices} onClose={close} />
    </ErrorBoundary>
  );
}
