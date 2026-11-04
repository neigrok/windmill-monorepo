import React, { useEffect, useRef, useState } from 'react';
import './board.css';

export function BoardToast({ toast, phone = false, ready = true, blocked = false, onToastShown, onToastReveal, onToastUndo }) {
  const [visibleToast, setVisibleToast] = useState(null);
  const onShown = useRef(onToastShown);
  onShown.current = onToastShown;

  useEffect(() => {
    if (!toast || visibleToast === toast.key || !ready || blocked) return undefined;
    const timer = setTimeout(() => {
      setVisibleToast(toast.key);
      onShown.current?.(toast.key);
    }, 120);
    return () => clearTimeout(timer);
  }, [toast?.key, visibleToast, ready, blocked]);

  return (
    <>
      {toast && !blocked && <div className="st-board-spoken" role="status" aria-live="polite" aria-atomic="true">{visibleToast === toast.key ? toast.message : ''}</div>}
      {toast && !blocked && visibleToast === toast.key && (
        <div className={`st-board-toast${toast.leaving ? ' is-leaving' : ''}${toast.act ? ` st-board-toast--${toast.act}` : ''}`}>
          {phone && toast.act === 'complete' && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m5 12 4 4 10-10" /></svg>}
          {toast.reveal
            ? <button type="button" className="st-board-toast-message" onClick={onToastReveal}>{toast.message}</button>
            : <span className="st-board-toast-message">{toast.message}</span>}
          {toast.action && <button type="button" className="st-board-toast-undo" onClick={onToastUndo}>{toast.action.label}</button>}
        </div>
      )}
    </>
  );
}
