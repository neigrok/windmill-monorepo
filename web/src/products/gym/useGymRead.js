// ONE READ, FOUR ANSWERS — the shape every route-owned screen in gym uses to ask the store a
// question: the session detail, Today's routines, the routines list, one routine's editor and the
// finish screen. They all need the same four states and the same repair, and five copies of this
// dance is five chances for one of them to leave a screen saying "opening…" forever.
//
// `absent` is its own answer and not a failure: a routine another account owns and a routine that
// never existed are one fact on this wire, and a read that resolves to null is that fact. A read
// that THREW is the other thing entirely — the log did not answer — and it is the only one offered a
// retry, because it is the only one retrying could fix.
//
// The reader is called on the deps it is given and on nothing else. Passing it in the array would
// re-run the read on every render, which for a screen that also holds a draft is a read that wipes
// what the lifter has typed.

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  return { ...view, retry };
}
