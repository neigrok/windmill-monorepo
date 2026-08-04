// The echoes the nightly sweep left for you — each one a newer day quietly repeating something you
// wrote at least a fortnight earlier. Loaded once when the journal opens (they surface on arrival, never
// in the session that triggered them), keyed by their trigger day so the canvas can mark that day. A
// non-subscriber simply gets none — absent, not locked. Dismissing retires an echo for good and drops
// its mark right away.

import { useCallback, useEffect, useState } from 'react';
import { journalApi } from './journalApi.js';
import { localDay } from './hlc.js';

export function useEchoes() {
  const [byTriggerDay, setByTriggerDay] = useState(new Map());

  useEffect(() => {
    let cancelled = false;
    journalApi.echoes('0001-01-01', localDay())
      .then((echoes) => {
        if (cancelled) return;
        setByTriggerDay(new Map(echoes.map((echo) => [echo.triggerDay, echo])));
      })
      .catch(() => { /* no echoes to show — leave the canvas quiet */ });
    return () => { cancelled = true; };
  }, []);

  const dismiss = useCallback((triggerDay) => {
    setByTriggerDay((cur) => {
      const next = new Map(cur);
      next.delete(triggerDay);
      return next;
    });
    // KNOWN DEFECT: the sweep CAN re-add this. saveEcho's upsert resets dismissed = false, and a page
    // stays a trigger for every pass inside the 24h look-back — so a dismissal made today can be undone
    // by tonight's sweep and the echo returns on the next load. Fixed by the ECHOES.md replacement,
    // where dismissals are keyed to the passage pair and survive re-derivation.
    journalApi.dismissEcho(triggerDay).catch(() => { /* the mark is already gone locally */ });
  }, []);

  return { byTriggerDay, dismiss };
}
