// Phases: loading / ready / absent (reader resolved null) / failed.

import { useCallback, useEffect, useState } from 'react';

export function useGymRead(read, deps) {
  const [view, setView] = useState({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setView({ phase: 'loading' });
    read()
      .then((data) => {
        if (!live) return;
        setView(data == null ? { phase: 'absent' } : { phase: 'ready', data });
      })
      .catch(() => { if (live) setView({ phase: 'failed' }); });
    return () => { live = false; };
    // `read` is out of deps: re-reading every render would wipe screen drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  return { ...view, retry };
}
