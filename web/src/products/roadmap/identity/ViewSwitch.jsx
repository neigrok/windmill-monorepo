// Board ⇄ Graph uses the same icon targets on every band. The canvas view is 'tree'.

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { Tooltip } from '../../../design-system';
import { GRAPH_UNAVAILABLE, VIEW_SWITCH } from '../copy.js';

const GLYPHS = {
  board: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.66667" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="3.33333" width="3.5" height="13.33333" rx="1" />
      <rect x="8.25" y="3.33333" width="3.5" height="9.16667" rx="1" />
      <rect x="14" y="3.33333" width="3.5" height="11.66667" rx="1" />
    </svg>
  ),
  tree: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.66667" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="10" cy="4.16667" r="2.08333" />
      <circle cx="5" cy="15.8333" r="2.08333" />
      <circle cx="15" cy="15.8333" r="2.08333" />
      <path d="M10 6.25V9.58333M10 9.58333L5.83333 14.1667M10 9.58333L14.1667 14.1667" />
    </svg>
  ),
};

const OPTIONS = [
  { view: 'board', label: VIEW_SWITCH.board },
  { view: 'tree', label: VIEW_SWITCH.graph },
];

export function ViewSwitch({ view, onSwitch, phone = false, graphUnavailable = false, onGraphUnavailable }) {
  return (
    <div className={`st-board-switch ${phone ? 'st-board-switch--phone' : 'st-board-switch--wide'}`} role="group" aria-label={VIEW_SWITCH.group}>
      {OPTIONS.map((option) => {
        if (option.view === 'tree' && graphUnavailable) {
          return <UnavailableGraph key={option.view} phone={phone} onPress={onGraphUnavailable} />;
        }
        const button = (
          <button
            key={option.view}
            type="button"
            className="st-board-switch-option"
            aria-label={option.label}
            aria-pressed={view === option.view}
            onClick={() => { if (view !== option.view) onSwitch(option.view); }}
          >
            {GLYPHS[option.view]}
          </button>
        );
        return phone ? button : <Tooltip key={option.view} label={option.label} side="bottom">{button}</Tooltip>;
      })}
    </div>
  );
}

function UnavailableGraph({ phone, onPress }) {
  const reasonId = useId();
  const root = useRef(null);
  const button = useRef(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 16, top: 0 });
  const shown = open && !phone;

  useLayoutEffect(() => {
    if (!shown) return undefined;
    const place = () => {
      const box = button.current.getBoundingClientRect();
      setPosition({ left: Math.max(16, Math.min(box.left - 84, window.innerWidth - 308)), top: box.bottom + 10 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [shown]);

  useEffect(() => {
    if (!shown) return undefined;
    const outside = (event) => {
      if (!root.current.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [shown]);

  return (
    <span ref={root} className="st-graph-unavailable" onMouseLeave={() => setOpen(false)}>
      <button ref={button} type="button" className="st-board-switch-option" aria-label={VIEW_SWITCH.graph}
        aria-pressed={false} aria-disabled="true" aria-describedby={reasonId}
        onMouseEnter={() => setOpen(true)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onClick={() => { setOpen(true); onPress?.(); }}>
        {GLYPHS.tree}
      </button>
      <span id={reasonId} role={phone ? undefined : 'tooltip'} className={phone ? 'st-graph-unavailable-description' : 'st-graph-unavailable-reason'}
        hidden={!phone && !shown} style={phone ? undefined : position}>
        {!phone && <CircleAlert size={20} aria-hidden />}
        <span>{GRAPH_UNAVAILABLE}</span>
      </span>
    </span>
  );
}
