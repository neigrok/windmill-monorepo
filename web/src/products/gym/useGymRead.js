// ONE READ, FOUR ANSWERS — the shape every room in gym uses to ask the store a question: the
// session detail, the routines list, one routine's editor, the finish screen, a movement's record
// and the coach's shared page. They all need the same four states and the same repair, and six
// copies of this dance is six chances for one of them to leave a screen saying "opening…" forever.
//
// The movement picker is the seventh and the only one that is not a route: it opens OVER a room
// rather than being one, so its read (the last set of every movement, §B7) begins when it is mounted
// and is dropped with it — which is exactly the lifetime this hook already gives a screen.
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
