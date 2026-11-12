import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { track } from '../../../telemetry/beacon.js';
import { t } from '../i18n/index.js';
import { LocalTreeRegistry } from '../persistence/LocalTreeRegistry.js';
import { setGuide } from '../persistence/TreeRegistry.js';
import { reportUnexpectedFailure } from '../reportFailure.js';
import { setLocalGuide } from '../sync/localTrees.js';
import { InadmissibleGuide, guideLengthBucket, hasGuide } from './GuideDraft.js';

// The room's guide: whether this person sees one, whether its note stands open, the door a save takes and the beat a
// guide set elsewhere earns. Null where no guide shows: the shared reader's route and the demo, and a reader's tree
// without one. `opened` is null while the guide rests on the tree, else { writing: null | { offset }, keyboard }: a note
// opened to read, or to write from that offset, and whether a key opened it. `entry` holds the guide's control on the
// tree, which the note opens from and hands focus back to.
export function useRoomGuide({ treeId, tree, who, deviceLine, sessionRef }) {
  const text = tree?.guide ?? '';
  const { owner } = who;
  const [opened, setOpened] = useState(null);
  const [arrival, setArrival] = useState(0);
  const entry = useRef(null);
  const seen = useRef(null);
  const ownWrite = useRef(null);

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
    if (!owner) {
      track('roadmap_guide', { step: 'save', outcome: 'failed', length, reason: 'refused' });
      return false;
    }
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
  }, [treeId, text, owner, sessionRef]);

  const shown = Boolean(tree) && !who.shared && !who.demo && (who.owner || (who.reader && hasGuide(text)));
  const roadmapTitle = tree?.title?.trim() || t('roadmap.common.untitled');
  // The note closes when the tree changes or the guide stops being shown, so it never stands open without an open.
  useEffect(() => setOpened(null), [treeId, shown]);
  return useMemo(() => (shown ? {
    text,
    owner: who.owner,
    deviceOnly: Boolean(deviceLine),
    roadmapTitle,
    arrival,
    entry,
    opened,
    open: (writing = null, keyboard = false) => setOpened({ writing, keyboard }),
    close: () => setOpened(null),
    save,
  } : null), [shown, text, who.owner, deviceLine, roadmapTitle, arrival, opened, save]);
}

// The one crossfade a guide set elsewhere earns where it is read: none on a first showing, none under reduced motion.
export function useArrivalFade(shown, arrival) {
  const seen = useRef(arrival);
  useLayoutEffect(() => {
    if (arrival === seen.current) return;
    seen.current = arrival;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    shown.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
  }, [arrival]);
}
