import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { track } from '../../../telemetry/beacon.js';
import { t } from '../i18n/index.js';
import { LocalTreeRegistry } from '../persistence/LocalTreeRegistry.js';
import { setGuide } from '../persistence/TreeRegistry.js';
import { reportUnexpectedFailure } from '../reportFailure.js';
import { setLocalGuide } from '../sync/localTrees.js';
import { InadmissibleGuide, guideLengthBucket, hasGuide } from './GuideDraft.js';

// The room's guide: whether this person sees one, the surface open on it, the door a save takes and the beat a guide
// set elsewhere earns. Null where no guide shows: the shared reader's route and the demo, and a reader's tree without one.
// A surface is { kind: 'modal' | 'note' | 'editor', writing: null | { via, offset } }.
export function useRoomGuide({ treeId, tree, who, deviceLine, sessionRef }) {
  const text = tree?.guide ?? '';
  const [surface, setSurface] = useState(null);
  const [arrival, setArrival] = useState(0);
  const seen = useRef(null);
  const ownWrite = useRef(null);

  useEffect(() => setSurface(null), [treeId, who.phone]);

  // A guide set in another tab or by an agent earns one beat; the first read and this room's own save earn none.
  useEffect(() => {
    if (!tree) return;
    const before = seen.current;
    seen.current = { treeId: tree.id, text };
    if (before?.treeId !== tree.id || before.text === text) return;
    if (ownWrite.current === text) {
      ownWrite.current = null;
      return;
    }
    setArrival((count) => count + 1);
  }, [tree, text]);

  // The session's stamped register when it can take the write, as a rename; before its lattice loads, the device blob
  // for a tree that lives only here and the server's PATCH for the rest. A save over a guide that changed since writing
  // began, last writer winning, leaves a conflict beside it.
  const save = useCallback(async (draft) => {
    const next = draft.saved;
    const length = guideLengthBucket(next ? draft.length : 0);
    if (next === text) {
      track('roadmap_guide', { step: 'save', outcome: 'unchanged', length });
      return true;
    }
    ownWrite.current = next;
    let door = 'session';
    try {
      const session = sessionRef.current;
      if (session?.treeId !== treeId || !session.setGuide(next)) {
        door = new LocalTreeRegistry().get(treeId)?.claimed === false ? 'device' : 'server';
        await (door === 'device' ? setLocalGuide(treeId, next) : setGuide(treeId, next));
      }
    } catch (error) {
      ownWrite.current = null;
      reportUnexpectedFailure('roadmap-guide-save', error);
      const refused = error instanceof InadmissibleGuide || (error?.status >= 400 && error.status < 500);
      track('roadmap_guide', { step: 'save', outcome: 'failed', length,
        reason: error?.status === 0 ? 'offline' : refused ? 'refused' : door === 'server' ? 'server' : 'device' });
      return false;
    }
    track('roadmap_guide', { step: 'save', outcome: next ? 'saved' : 'cleared', length });
    if (draft.outdatedBy(text)) track('roadmap_guide', { step: 'conflict' });
    return true;
  }, [treeId, text, sessionRef]);

  const shown = Boolean(tree) && !who.shared && !who.demo && (who.owner || (who.reader && hasGuide(text)));
  const roadmapTitle = tree?.title?.trim() || t('roadmap.common.untitled');
  return useMemo(() => (shown ? {
    text,
    owner: who.owner,
    deviceOnly: Boolean(deviceLine),
    roadmapTitle,
    arrival,
    surface,
    open: (kind) => setSurface({ kind, writing: null }),
    write: (kind, writing) => setSurface({ kind, writing }),
    close: () => setSurface(null),
    save,
  } : null), [shown, text, who.owner, deviceLine, roadmapTitle, arrival, surface, save]);
}
