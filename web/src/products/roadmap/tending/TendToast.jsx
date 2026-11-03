import React, { useEffect, useState } from 'react';
import { track } from '../../../telemetry/beacon.js';
import { TEND_TOAST } from '../board/copy.js';

// Ask AI's answers, in the pill 08.02 draws for them: a receipt may open its reason, and reading it holds the toast.
export function TendToast({ toast, overCanvas, style, onShown, onPause, onAct }) {
  const [whyOpen, setWhyOpen] = useState(false);
  useEffect(() => { onShown(toast.key); }, [toast.key, onShown]);

  const toggleWhy = () => {
    if (whyOpen) onShown(toast.key);
    else {
      track('roadmap_verb', { verb: 'askAI', step: 'why' });
      onPause();
    }
    setWhyOpen(!whyOpen);
  };

  return (
    <div style={style} role="status"
      className={`st-toast${overCanvas ? ' st-toast--graph' : ''}${toast.leaving ? ' is-leaving' : ''}${toast.detail && whyOpen ? ' st-toast--expanded' : ''}`}>
      <div className="st-toast-row">
        <span>{toast.message}</span>
        {toast.detail && <button type="button" className="st-toast-why" onClick={toggleWhy}>{whyOpen ? TEND_TOAST.hide : TEND_TOAST.why}</button>}
        {toast.action && <button type="button" className="st-toast-undo" onClick={onAct}>{toast.action.label}</button>}
      </div>
      {toast.detail && whyOpen && <p className="st-toast-detail">{toast.detail}</p>}
    </div>
  );
}
