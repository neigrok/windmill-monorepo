import { useCallback, useEffect, useState } from 'react';
import { listAllTrees } from '../persistence/TreeRegistry.js';
import { ReplicaReading } from '../room/ReplicaReading.js';
import { prefersReducedMotion } from '../theme.js';
import { COACHED_NODE_ID, COACH_DONE_KEY, coachEligible } from './demoStage.js';

const CTA_ECHO_DELAY = 1500;
const CTA_ECHO_MS = 2600;

// The demo's play: whether the chip may coach this visitor, and the Fork pill's echo once the coached step is done. A
// person signed in who owns a roadmap is not coached: their roadmaps are read from the device's copy where the room reads
// it (`replica`), else from the server's list and this device's index. A list that cannot be read owns nothing.
export function useDemoCoach({ demo, status, replica = false }) {
  const [coachAllowed, setCoachAllowed] = useState(false);
  const [demoCompletions, setDemoCompletions] = useState(0);
  const [ctaEcho, setCtaEcho] = useState(false);

  useEffect(() => {
    if (!demo || status === 'loading') return undefined;
    let coachDone = false;
    try { coachDone = !!localStorage.getItem(COACH_DONE_KEY); } catch { /* private mode */ }
    if (status !== 'signed-in') { setCoachAllowed(coachEligible({ coachDone, signedIn: false, ownsTrees: false })); return undefined; }
    let cancelled = false;
    const wanted = new AbortController();
    const reading = replica ? new ReplicaReading({ treeId: null }) : null;
    (reading ? reading.readEveryRoadmap({ signal: wanted.signal }).then((roadmaps) => (roadmaps === null ? [] : reading.list())) : listAllTrees())
      .then((trees) => { if (!cancelled) setCoachAllowed(coachEligible({ coachDone, signedIn: true, ownsTrees: trees.length > 0 })); })
      .catch(() => { if (!cancelled) setCoachAllowed(false); })
      .finally(() => reading?.close());
    return () => {
      cancelled = true;
      wanted.abort();
      reading?.close();
    };
  }, [demo, status]);

  const noteCompletion = useCallback((id) => {
    if (!demo) return;
    setDemoCompletions((count) => count + 1);
    if (id === COACHED_NODE_ID && !prefersReducedMotion()) {
      setTimeout(() => { setCtaEcho(true); setTimeout(() => setCtaEcho(false), CTA_ECHO_MS); }, CTA_ECHO_DELAY);
    }
  }, [demo]);

  return { coachAllowed, demoCompletions, ctaEcho, noteCompletion };
}
