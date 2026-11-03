import { useCallback, useEffect, useRef, useState } from 'react';

const LEAVE_MS = 280; // matches the CSS exit
const HOLD_MS = 4000;
const HOLD_WITH_ACTION_MS = 6000;

// A Board toast waits out the regroup, a Graph toast leaves with the canvas, Ask AI has its pill; any other stands over what shows.
export function toastSeat(toast, { canvasView, stepOpen }) {
  if (!toast || toast.surface === 'tend') return null;
  if (toast.surface === 'board') return 'board';
  if (canvasView) return 'room';
  if (toast.surface === 'graph') return null;
  return stepOpen ? 'room' : 'board';
}

// The room's one toast slot. A toast's hold starts when it is first shown; a newer one replaces it.
export function useRoadmapToast() {
  const timersRef = useRef([]);
  const keyRef = useRef(0);
  const liveToastRef = useRef(null);
  const [toast, setToast] = useState(null);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  const showToast = useCallback((message, options = {}) => {
    liveToastRef.current?.onLeave?.('replaced');
    clearTimers();
    const next = {
      surface: 'room', ...options,
      holdMs: options.holdMs ?? (options.action ? HOLD_WITH_ACTION_MS : HOLD_MS),
      message, key: (keyRef.current += 1), leaving: false, started: false,
    };
    liveToastRef.current = next;
    setToast(next);
  }, [clearTimers]);

  const toastShown = useCallback((key) => {
    const current = liveToastRef.current;
    if (!current || current.key !== key || current.started) return;
    current.started = true;
    timersRef.current.push(setTimeout(() => {
      if (liveToastRef.current !== current) return;
      current.onLeave?.('timer');
      liveToastRef.current = null;
      setToast((shown) => (shown?.key === key ? { ...shown, leaving: true } : shown));
      timersRef.current.push(setTimeout(() => setToast((shown) => (shown?.key === key ? null : shown)), LEAVE_MS));
    }, current.holdMs));
  }, []);

  // The hold stops until the toast is shown again.
  const pauseToast = useCallback(() => {
    clearTimers();
    if (liveToastRef.current) liveToastRef.current.started = false;
  }, [clearTimers]);

  const dismissToast = useCallback((via = 'replaced') => {
    liveToastRef.current?.onLeave?.(via);
    liveToastRef.current = null;
    clearTimers();
    setToast(null);
  }, [clearTimers]);

  const dismissToastIf = useCallback((leaves, via) => {
    if (liveToastRef.current && leaves(liveToastRef.current)) dismissToast(via);
  }, [dismissToast]);

  // An action may say something of its own, and what it says stands.
  const runToastAction = useCallback((shown) => {
    shown.action?.run();
    const live = liveToastRef.current;
    if (!live || live.key === shown.key) dismissToast();
  }, [dismissToast]);

  useEffect(() => clearTimers, [clearTimers]);
  return { toast, showToast, toastShown, pauseToast, dismissToast, dismissToastIf, runToastAction };
}
