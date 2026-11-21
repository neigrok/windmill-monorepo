// §6 What the room tells its owner once of their own changes that met another device's (flow 48): a step their edit
// brought back, and a step that now follows something else than they linked, through a step deleted elsewhere. Each line
// stands under its step on the Board and on its page for the rest of the visit; the first time either shows it, the
// device clears it from its note (`ReplicaReading.tell`) and the room says so once. A later opening is quiet.

import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { track } from '../../../telemetry/beacon.js';
import { landingLine } from '../copy.js';

const NONE = new Map();

// The Board's share: each step's lines, and `shown`, which the Board calls when a step's line is in view, while it stands
// uncovered (null otherwise).
export const Landed = createContext({ lines: NONE, shown: null });

export function useRoomLanding({ room, treeId }) {
  const [lines, setLines] = useState(NONE);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const told = useRef(new Set());

  useEffect(() => {
    told.current = new Set();
    setLines(NONE);
  }, [treeId]);

  // The reading's lines as the replica holds them now, joined to those the visit already stands: a line no approved words
  // say stays in the device's note, untold.
  const adopt = useCallback((landed) => {
    setLines((current) => {
      const fresh = landed.filter((line) => landingLine(line) !== null && !(current.get(line.step) ?? []).some((held) => held.key === line.key));
      if (fresh.length === 0) return current;
      const next = new Map(current);
      for (const line of fresh) next.set(line.step, [...(next.get(line.step) ?? []), line]);
      return next;
    });
  }, []);

  // A step's lines were seen where it is listed (`board`) or on its page (`step`).
  const shown = useCallback((step, place) => {
    const fresh = (linesRef.current.get(step) ?? []).filter((line) => !told.current.has(line.key));
    if (fresh.length === 0) return;
    for (const line of fresh) {
      told.current.add(line.key);
      track('roadmap_landing', { rule: line.rule, place });
    }
    room.replicaRef.current?.tell(fresh);
  }, []);

  return useMemo(() => ({ lines, adopt, shown }), [lines, adopt, shown]);
}
