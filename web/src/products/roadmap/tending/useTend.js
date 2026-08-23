import { useCallback, useEffect, useRef, useState } from 'react';
import { startTend, fetchRun } from './tendingClient.js';
import { isTerminal, runFace } from './receipts.js';

const POLL_INTERVAL_MS = 1200;
const POLL_CEILING_MS = 90000;  // ceiling before we stop watching

// The poll is abortable: leaving the tree stops the watch, and the run carries on server-side with
// its receipt waiting on the catch-up read.
export function useTend({ treeId, onFace }) {
  const [working, setWorking] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const submit = useCallback(async (prompt) => {
    if (working || !prompt.trim()) return;
    setWorking(true);

    const started = await startTend(treeId, prompt);
    // A refusal comes back on the POST itself (200, no runId); a started run gives a runId to poll.
    let face;
    if (!started) face = runFace(null);
    else if (started.runId) face = runFace(await pollToRest(started.runId, aliveRef));
    else face = runFace(started);

    if (!aliveRef.current) return;
    setWorking(false);
    onFace(face);
  }, [treeId, working, onFace]);

  return { working, submit };
}

async function pollToRest(runId, aliveRef) {
  const deadline = Date.now() + POLL_CEILING_MS;
  while (aliveRef.current && Date.now() < deadline) {
    const run = await fetchRun(runId);
    if (isTerminal(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  // A run that hasn't settled reads as a miss rather than a stuck "Tending…" toast.
  if (!aliveRef.current) return null;
  const last = await fetchRun(runId);
  return isTerminal(last) ? last : null;
}
