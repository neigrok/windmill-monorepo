// The action lane (X8 §5) — the bottom band every verb lives in, because the top of a scrolling
// list is unreachable by definition. One rail: the view pill on the left, Share on the right (the
// owner's twin of the visitor's Fork pill), and the centre — the Tend bar — riding ABOVE the rail
// rather than between its ends, because a field wants the whole width where a pill wants a slot.
// The lane grows upward from the bottom edge, so nothing on the rail moves when tending lands.
//
// It also reports what it occupies. Its height is not knowable in advance — the Tend bar grows
// starter chips only while it is idle and empty, the pill comes and goes with the view — so it
// measures from its own top edge down to the bottom of the screen and hands that number to the
// host. The list ends its scroller exactly there, so no row is ever under a button — at rest or
// mid-scroll.

import React, { useEffect, useRef } from 'react';
import { Icon } from '../../../../design-system';

export function ActionLane({ left = null, center = null, right = null, lift = 0, onHeight }) {
  const laneRef = useRef(null);

  useEffect(() => {
    const lane = laneRef.current;
    if (!lane || !onHeight) return undefined;
    const report = () => onHeight(Math.max(0, window.innerHeight - lane.getBoundingClientRect().top));
    report();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(report) : null;
    observer?.observe(lane);
    window.addEventListener('resize', report);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [onHeight, lift]);

  return (
    <div className="st-action-lane" ref={laneRef} style={{ ...lane, bottom: `calc(env(safe-area-inset-bottom, 0px) + 16px + ${lift}px)` }}>
      {center && <div style={slot}>{center}</div>}
      {(left || right) && (
        <div style={rail}>
          <div style={slot}>{left}</div>
          <div style={slot}>{right}</div>
        </div>
      )}
    </div>
  );
}

// The lane's own control shape: a ≥44px cream pill, bark type, the same weight as the view pill
// beside it. A verb that earns the rail wears this — it is never a hue, because the rail is a tool.
export function LaneButton({ icon, label, onClick }) {
  return (
    <button type="button" onClick={onClick} style={laneButton}>
      <Icon name={icon} size={17} />
      {label}
    </button>
  );
}

export default ActionLane;

const lane = {
  position: 'fixed',
  left: 0,
  right: 0,
  zIndex: 22,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '0 calc(env(safe-area-inset-right, 0px) + 12px) 0 calc(env(safe-area-inset-left, 0px) + 12px)',
  pointerEvents: 'none', // the lane is mostly air; only its tenants take the finger
};
const rail = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 };
const slot = { display: 'flex', alignItems: 'center', pointerEvents: 'auto' };
const laneButton = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  minHeight: 44,
  padding: '0 16px',
  background: 'var(--surface-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-full)',
  boxShadow: 'var(--shadow-md)',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-sm)',
  fontWeight: 700,
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent',
};
