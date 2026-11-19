// §6 Kept here beside every room (flow 49.06): roadmap's notices read through the engine in every scope, and the records
// the carry-over set aside in the replica's ledger (§8.2), offered as the account menu's row while the list holds a
// change, and the list itself while the person has it open. Each change that cannot land is told to the intake once
// (`toldNotices.js`); a notice no rule of §6 lists is a failure, reported once by its code, `other` where the code is not
// one a refusal names.

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ErrorBoundary } from '../../../design-system';
import { useAccountRowOffer } from '../../../shell/ProductSessions.jsx';
import { useSyncEngine, useSyncNotices } from '../../../platform/sync/react.js';
import { track } from '../../../telemetry/beacon.js';
import { countBucket } from '../board/acts.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { t } from '../i18n/index.js';
import { carriedKept } from '../domain/carry.js';
import { RoadmapScopes } from '../domain/roadmapRules.js';
import { RoadmapNames, keptChanges } from './KeptChanges.js';
import { KeptList, listed } from './KeptList.jsx';
import { untoldNotices } from './toldNotices.js';

const NOTHING_KEPT = Object.freeze({ kept: [], unexpected: [] });
// A refusal code as the registry spells one; any other is reported as `other`.
const REFUSAL_CODE = /^[a-z][a-z0-9-]{0,63}$/;
const reportedCodes = new Set();
const NO_ENGINE = () => () => {};

// The records the carry-over set aside, as the active replica's ledger rows hold them, read again after each of the
// engine's writes: the same array while they say the same.
function useCarriedKept(engine) {
  const revision = useSyncExternalStore(engine?.observeEngine ?? NO_ENGINE, () => engine?.getSnapshot()?.revision ?? -1, () => -1);
  const said = useMemo(() => (engine ? JSON.stringify(carriedKept(engine.readMetadata(RoadmapScopes.account).devices)) : '[]'), [engine, revision]);
  return useMemo(() => JSON.parse(said), [said]);
}

export function KeptHere() {
  const engine = useSyncEngine();
  const { notices } = useSyncNotices('roadmap');
  const [opened, setOpened] = useState(0);
  const [open, setOpen] = useState(false);
  const carried = useCarriedKept(engine);
  const read = useMemo(() => engine ? keptChanges(notices, engine.registry, RoadmapNames.NONE, carried) : NOTHING_KEPT, [engine, notices, carried]);
  const shown = listed(read.kept).length;
  const counted = useRef(shown);
  counted.current = shown;

  useEffect(() => {
    if (!engine) return;
    const untold = new Set(untoldNotices([...notices.map((notice) => notice.id), ...read.kept.filter((change) => change.carriedFrom !== null).map((change) => change.id)]));
    for (const change of read.kept) if (untold.has(change.id)) track('roadmap_write_cannot_land', { reason: change.reason });
    for (const { id, code } of read.unexpected) {
      const tag = REFUSAL_CODE.test(code) ? code : 'other';
      if (!untold.has(id) || reportedCodes.has(tag)) continue;
      reportedCodes.add(tag);
      reportRoadmapFailure('roadmap-kept-unexpected', new Error('A notice no rule of the list lists'), { code: tag });
    }
  }, [engine, notices, read]);

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
      <KeptList engine={engine} notices={notices} carried={carried} onClose={close} />
    </ErrorBoundary>
  );
}
