// The person's roadmaps as the device's copy holds them, one row each leading into it (flow 51). A deletion of the open
// roadmap lands here with its Undo standing for the rest of its nine-second hold, with no countdown and a polite word
// that moves no focus; Undo returns the person to the roadmap, which says the deletion was undone.

import React, { useEffect, useRef, useState } from 'react';
import { readNavigation, requestNavigation } from '../../../shell/navigation.js';
import { track } from '../../../telemetry/beacon.js';
import { countBucket } from '../board/acts.js';
import { BoardToast } from '../board/BoardToast.jsx';
import { LABELS } from '../copy.js';
import { t } from '../i18n/index.js';
import { ReplicaReading } from '../room/ReplicaReading.js';
import { useRoadmapToast } from '../room/useRoadmapToast.js';
import { HeldDeletion } from './HeldDeletion.js';
import './identity.css';

export function YourRoadmaps() {
  const [rows, setRows] = useState(null);
  const [held] = useState(() => HeldDeletion.of(readNavigation().state));
  const readingRef = useRef(null);
  const { toast, showToast, toastShown, runToastAction } = useRoadmapToast();

  useEffect(() => {
    const wanted = new AbortController();
    const reading = new ReplicaReading({ treeId: null });
    readingRef.current = reading;
    let first = true;
    reading.readRoadmaps({ signal: wanted.signal, onList: (list) => {
      setRows(list);
      if (!first) return;
      first = false;
      track('roadmap_your_roadmaps', { step: 'shown', count: countBucket(list.length) });
    } }).then((stood) => { if (!stood && !wanted.signal.aborted) setRows([]); });
    return () => {
      wanted.abort();
      reading.close();
      readingRef.current = null;
    };
  }, []);

  // The deletion's Undo, for what is left of its hold. Once the hold has ended the deletion is permanent, and an Undo
  // that comes too late takes nothing back.
  useEffect(() => {
    const holding = held?.undone === false ? held.remainingAt(Date.now()) : 0;
    if (holding === 0) return;
    showToast(t('roadmap.deletion.held'), { act: 'delete', holdMs: holding, action: { label: LABELS.undo, run: () => requestNavigation({
      key: `roadmap:undelete:${held.treeId}`,
      run: async (transaction) => {
        const back = await readingRef.current?.writes?.undeleteRoadmap(held) ?? false;
        track('roadmap_deletion', { step: 'undo', outcome: back ? 'cancelled' : 'released' });
        if (back) held.returnTo(transaction);
      },
    }) } });
    track('roadmap_deletion', { step: 'held' });
  }, [held, showToast]);

  return (
    <div className="st-roadmaps">
      <div className="st-roadmaps-page">
        <h1 className="st-roadmaps-title">{t('roadmap.yourRoadmaps.title')}</h1>
        {rows && rows.length > 0 && (
          <ul className="st-roadmaps-list">
            {rows.map((row) => (
              <li key={row.id}>
                <a className="st-roadmaps-row" href={`#/app/${row.id}`} onClick={() => track('roadmap_your_roadmaps', { step: 'open' })}>
                  <span className="st-roadmaps-row-title">{row.title.trim() || t('roadmap.common.untitled')}</span>
                  <svg className="st-roadmaps-row-open" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
      <BoardToast toast={toast} onToastShown={toastShown} onToastUndo={() => runToastAction(toast)} />
    </div>
  );
}

export default YourRoadmaps;
