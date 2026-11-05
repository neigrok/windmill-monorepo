import React, { useEffect, useRef, useState } from 'react';
import './board.css';

const CHECKED_ACTS = new Set(['complete', 'fork']);

export function BoardToast({ toast, phone = false, ready = true, blocked = false, onToastShown, onToastReveal, onToastUndo }) {
  const [visibleToast, setVisibleToast] = useState(null);
  const onShown = useRef(onToastShown);
  onShown.current = onToastShown;
  const waiting = blocked && !toast?.overRefusal;

  useEffect(() => {
    if (!toast || visibleToast === toast.key || !ready || waiting) return undefined;
    const timer = setTimeout(() => {
      setVisibleToast(toast.key);
      onShown.current?.(toast.key);
    }, 120);
    return () => clearTimeout(timer);
  }, [toast?.key, visibleToast, ready, waiting]);

  return (
    <>
      {toast && !waiting && <div className="st-board-spoken" role="status" aria-live="polite" aria-atomic="true">{visibleToast === toast.key ? toast.message : ''}</div>}
      {toast && !waiting && visibleToast === toast.key && (
        <div className={`st-board-toast${toast.leaving ? ' is-leaving' : ''}${toast.act ? ` st-board-toast--${toast.act}` : ''}`}>
          {phone && CHECKED_ACTS.has(toast.act) && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m5 12 4 4 10-10" /></svg>}
          {toast.reveal
            ? <button type="button" className="st-board-toast-message" onClick={onToastReveal}>{toast.message}</button>
            : <span className="st-board-toast-message">{toast.message}</span>}
          {toast.action && <button type="button" className="st-board-toast-undo" onClick={onToastUndo}>{toast.action.label}</button>}
        </div>
      )}
    </>
  );
}
