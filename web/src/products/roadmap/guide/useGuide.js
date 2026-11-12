import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { track } from '../../../telemetry/beacon.js';
import { t } from '../i18n/index.js';
import { LocalTreeRegistry } from '../persistence/LocalTreeRegistry.js';
import { readGuides, setGuide } from '../persistence/TreeRegistry.js';
import { reportUnexpectedFailure } from '../reportFailure.js';
import { setLocalGuide } from '../sync/localTrees.js';
import { guideLengthBucket, hasGuide, saveFailureReason } from './GuideDraft.js';
import { guidesAbove } from './GuidesAbove.js';

const NONE_ABOVE = Object.freeze([]);

// The room's guide: whether this person sees one, whether its note stands open, the door a save takes and the beat a
// guide set elsewhere earns. Null where no guide shows: the shared reader's route and the demo, and a reader's tree
// without one. `opened` is null while the guide rests on the tree, else { writing: null | { offset }, keyboard }: a note
// opened to read, or to write from that offset, and whether a key opened it. `entry` holds the guide's control on the
// tree, which the note opens from and hands focus back to. `above` holds the guides of the holder's trees above this
// one, farthest first, each { treeId, title, text }: empty where there are none and for anyone but `holder`, the
// account that holds the room as its owner.
export function useRoomGuide({ treeId, tree, who, holder, deviceLine, sessionRef }) {
  const text = tree?.guide ?? '';
  const { owner } = who;
  const [opened, setOpened] = useState(null);
  const [arrival, setArrival] = useState(0);
  const [read, setRead] = useState(null);
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
  // began, last writer winning, leaves a conflict beside it. It answers null once a door took the guide or nothing
  // changed, else why none did: the reason its event carries and the note's line says.
  const save = useCallback(async (draft) => {
    const next = draft.saved;
    const length = guideLengthBucket(next ? draft.length : 0);
    if (!owner) {
      track('roadmap_guide', { step: 'save', outcome: 'failed', length, reason: 'refused' });
      return 'refused';
    }
    if (next === text) {
      track('roadmap_guide', { step: 'save', outcome: 'unchanged', length });
      return null;
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
      const reason = saveFailureReason(error, door, navigator.onLine !== false);
      track('roadmap_guide', { step: 'save', outcome: 'failed', length, reason });
      return reason;
    }
    track('roadmap_guide', { step: 'save', outcome: next ? 'saved' : 'cleared', length });
    if (draft.outdatedBy(text)) track('roadmap_guide', { step: 'conflict' });
    return null;
  }, [treeId, text, owner, sessionRef]);

  // The guides above are read once each time the room opens a tree for its holder, and kept in memory alone. A tree
  // that lives only on this device has none to ask for. Leaving the tree aborts the read, a reply is held for the tree
  // and the holder it was read for, and a read that failed leaves the tree's own guide standing and says nothing.
  useEffect(() => {
    if (!holder || new LocalTreeRegistry().get(treeId)?.claimed === false) return undefined;
    const request = new AbortController();
    readGuides(treeId, request.signal).then((reply) => {
      if (!request.signal.aborted) setRead({ treeId, holder, above: guidesAbove(reply, { treeId, untitled: t('roadmap.common.untitled') }) });
    }, (error) => {
      if (!request.signal.aborted) reportUnexpectedFailure('roadmap-guides-load', error);
    });
    return () => request.abort();
  }, [treeId, holder]);
  const above = holder && read?.treeId === treeId && read.holder === holder ? read.above : NONE_ABOVE;

  const shown = Boolean(tree) && !who.shared && !who.demo && (who.owner || (who.reader && hasGuide(text)));
  const roadmapTitle = tree?.title?.trim() || t('roadmap.common.untitled');
  // The note closes when the tree changes or the guide stops being shown, so it never stands open without an open.
  useEffect(() => setOpened(null), [treeId, shown]);
  return useMemo(() => (shown ? {
    text,
    above,
    owner: who.owner,
    deviceOnly: Boolean(deviceLine),
    roadmapTitle,
    arrival,
    entry,
    opened,
    open: (writing = null, keyboard = false) => setOpened({ writing, keyboard }),
    close: () => setOpened(null),
    save,
  } : null), [shown, text, above, who.owner, deviceLine, roadmapTitle, arrival, opened, save]);
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
