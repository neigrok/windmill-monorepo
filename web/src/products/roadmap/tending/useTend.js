import { useCallback, useEffect, useRef, useState } from 'react';
import { startTend, fetchRun } from './tendingClient.js';
import { isTerminal, runFace } from './receipts.js';

const POLL_INTERVAL_MS = 1200;
const POLL_CEILING_MS = 90000;  // an agent loop runs tens of seconds; a generous ceiling before we stop watching

// Drives one tend at a time: POST the sentence, then poll the run to rest while the tree updates
// itself live over the collab socket (the agent's edits arrive as ordinary remote frames — the
// "watch it" is free). `working` gates the bar into its thinking line; each finished run is handed
// to `onFace` as the quiet face it earned. The poll is abortable — leaving the tree stops the watch,
// and the run simply carries on server-side, its receipt waiting on the catch-up read next time.
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
  // Past the ceiling the run is still going server-side; a run that hasn't settled reads as a miss
  // ("nothing changed — your sentence is still here") rather than a stuck "Tending…" toast. Its real
  // receipt waits on the catch-up read next time the tree opens.
  if (!aliveRef.current) return null;
  const last = await fetchRun(runId);
  return isTerminal(last) ? last : null;
}
