// Measures from its own top edge to the bottom of the screen and hands that height to the host,
// which ends the list scroller exactly there so no row lies under a button.

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

// A ≥44px cream pill, bark type — never a hue.
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
