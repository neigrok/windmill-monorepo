// Phases: loading / ready / absent (reader resolved null) / failed. `retry` reads again from
// loading; `refresh` reads again in place, keeping what is drawn until the new read lands, so a
// screen that learned its data moved can re-read without unmounting whatever it holds open.

import { useCallback, useEffect, useState } from 'react';
import { useSyncRecords } from '../../platform/sync/react.js';

export function useGymRead(read, deps, { sync = false, ready = true } = {}) {
  const records = useSyncRecords('self/gym');
  const [view, setView] = useState({ phase: 'loading' });
  const [attempt, setAttempt] = useState({ count: 0, inPlace: false });

  useEffect(() => {
    let live = true;
    if (!ready) { setView({ phase: 'loading' }); return; }
    if (!attempt.inPlace) setView((current) => sync && current.phase === 'ready' ? current : { phase: 'loading' });
    read()
      .then((data) => {
        if (!live) return;
        setView(data == null ? { phase: 'absent' } : { phase: 'ready', data });
      })
      .catch(() => { if (live) setView({ phase: 'failed' }); });
    return () => { live = false; };
    // `read` is out of deps: re-reading every render would wipe screen drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt, ready, sync ? records : null]);

  const retry = useCallback(() => setAttempt((held) => ({ count: held.count + 1, inPlace: false })), []);
  const refresh = useCallback(() => setAttempt((held) => ({ count: held.count + 1, inPlace: true })), []);
  return { ...view, retry, refresh };
}
