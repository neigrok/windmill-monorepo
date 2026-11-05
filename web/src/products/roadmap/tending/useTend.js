import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTending, startTend, fetchRun } from './tendingClient.js';
import { isTerminal, runFace } from './receipts.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { LABELS, TEND_TOAST } from '../copy.js';
import { track } from '../../../telemetry/beacon.js';

const POLL_INTERVAL_MS = 1200;
const POLL_CEILING_MS = 90000;  // ceiling before we stop watching

// The poll is abortable: leaving the tree stops the watch, and the run carries on server-side with
// its receipt waiting on the catch-up read.
export function useTend({ treeId, onFace, onStart }) {
  const [working, setWorking] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const submit = useCallback(async (prompt) => {
    if (working || !prompt.trim()) return;
    onStart();
    setWorking(true);
    track('roadmap_verb', { verb: 'askAI', step: 'send' });

    const started = await startTend(treeId, prompt);
    // A refusal comes back on the POST itself (200, no runId); a started run gives a runId to poll.
    let face;
    if (!started) face = runFace(null);
    else if (started.runId) face = runFace(await pollToRest(started.runId, aliveRef));
    else face = runFace(started);

    if (!aliveRef.current) return;
    setWorking(false);
    onFace(face);
  }, [treeId, working, onFace, onStart]);

  return { working, submit };
}

async function pollToRest(runId, aliveRef) {
  const deadline = Date.now() + POLL_CEILING_MS;
  while (aliveRef.current && Date.now() < deadline) {
    const run = await fetchRun(runId);
    if (isTerminal(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  // A run that hasn't settled reads as a miss rather than a stuck "Updating roadmap…" toast.
  if (!aliveRef.current) return null;
  const last = await fetchRun(runId);
  return isTerminal(last) ? last : null;
}

// Ask AI in the room: who may use it, whether it is open, and the toast each answer leaves behind.
export function useRoomTend({ treeId, treeMine, status, shared, demo, demotion, room: { sessionRef, sceneRef }, showToast }) {
  const [tendingEnabled, setTendingEnabled] = useState(false);
  const [tendOpen, updateTendOpen] = useState(false);
  const [tendFailure, setTendFailure] = useState('');
  const clearTendFailure = useCallback(() => setTendFailure(''), []);
  const setTendOpen = useCallback((next) => {
    setTendFailure('');
    updateTendOpen(next);
  }, []);
  useEffect(() => {
    if (!treeMine || status !== 'signed-in' || demo) { setTendingEnabled(false); return undefined; }
    let alive = true;
    fetchTending().then((summary) => { if (alive) setTendingEnabled(!!summary?.enabled); });
    return () => { alive = false; };
  }, [treeMine, status, demo, treeId]);

  const canTend = tendingEnabled && treeMine && !shared && !demo && !demotion;

  // The run wrote on the server, so no local receipt names it; `created` is exactly what it planted.
  const undoTend = useCallback((planted) => {
    try {
      if (!sessionRef.current?.dispatch({ kind: 'BulkDelete', nodeIds: planted, edges: [] })) return;
      track('roadmap_graph_toast', { act: 'tend', step: 'undo' });
      showToast(TEND_TOAST.reverted, { surface: 'tend' });
    } catch (error) {
      reportRoadmapFailure('roadmap-tend-undo', error);
    }
  }, [showToast]);

  const onTendFace = useCallback((face) => {
    if (face.kind === 'failed') setTendFailure(face.line);
    else setTendOpen(false);
    if (face.kind === 'empty') return;
    track('roadmap_verb', { verb: 'askAI', step: 'answer', outcome: face.kind });
    const isReceipt = face.kind === 'receipt';
    const hasUndo = isReceipt && face.created && face.created.length > 0;
    if (hasUndo) setTimeout(() => sceneRef.current?.frameNodes(face.created), 600);
    showToast(face.line, {
      surface: 'tend',
      holdMs: isReceipt ? 6000 : 5000,
      detail: isReceipt ? face.detail : undefined,
      action: hasUndo ? { label: LABELS.undo, run: () => undoTend(face.created) } : undefined,
    });
  }, [showToast, undoTend, setTendOpen]);

  const { working: tendWorking, submit: submitTend } = useTend({ treeId, onFace: onTendFace, onStart: clearTendFailure });

  return { canTend, tendOpen, setTendOpen, tendWorking, tendFailure, submitTend };
}
