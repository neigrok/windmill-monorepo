import { useCallback, useEffect, useRef, useState } from 'react';

// The room's one toast slot. A Board or Graph toast starts its hold when it is first shown; any other holds from now.
export function useRoadmapToast() {
  const toastTimersRef = useRef([]);
  const toastKeyRef = useRef(0);
  const boardToastRef = useRef(null);
  const [toast, setToast] = useState(null); // { message, action, detail, key, leaving }
  const [toastWhyOpen, setToastWhyOpen] = useState(false);
  const showToast = useCallback((message, options = {}) => {
    boardToastRef.current?.onLeave?.('replaced');
    boardToastRef.current = null;
    toastTimersRef.current.forEach(clearTimeout);
    toastTimersRef.current = [];
    if (['board', 'graph'].includes(options.surface)) {
      const next = { ...options, message, key: (toastKeyRef.current += 1), leaving: false, started: false };
      boardToastRef.current = next;
      setToast(next);
      return;
    }
    const action = options.action ?? null;
    const hold = options.duration ?? (action ? 6000 : 4000);
    const key = (toastKeyRef.current += 1);
    setToastWhyOpen(false);
    setToast({ message, action, detail: options.detail || null, key, leaving: false });
    const leave = setTimeout(() => {
      setToast((current) => (current && current.key === key ? { ...current, leaving: true } : current));
      const drop = setTimeout(() => setToast((current) => (current && current.key === key ? null : current)), 280); // matches the CSS exit
      toastTimersRef.current.push(drop);
    }, hold);
    toastTimersRef.current.push(leave);
  }, []);

  const boardToastShown = useCallback((key) => {
    const current = boardToastRef.current;
    if (!current || current.key !== key || current.started) return;
    current.started = true;
    const leave = setTimeout(() => {
      if (boardToastRef.current !== current) return;
      current.onLeave?.('timer');
      boardToastRef.current = null;
      setToast((shown) => shown?.key === key ? { ...shown, leaving: true } : shown);
      toastTimersRef.current.push(setTimeout(() => setToast((shown) => shown?.key === key ? null : shown), 280));
    }, current.holdMs);
    toastTimersRef.current.push(leave);
  }, []);

  const dismissToast = useCallback(() => {
    boardToastRef.current?.onLeave?.('replaced');
    boardToastRef.current = null;
    toastTimersRef.current.forEach(clearTimeout);
    toastTimersRef.current = [];
    setToast(null);
  }, []);

  useEffect(() => () => toastTimersRef.current.forEach(clearTimeout), []);
  return { toast, toastWhyOpen, setToastWhyOpen, toastTimersRef, boardToastRef, showToast, boardToastShown, dismissToast };
}
