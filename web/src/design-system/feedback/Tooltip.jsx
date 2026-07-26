import React from 'react';

export function Tooltip({ children, label, side = 'top' }) {
  const [show, setShow] = React.useState(false);
  const pos = {
    top: { bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 8 },
    bottom: { top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: 8 },
  }[side] || {};
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <span
          style={{
            position: 'absolute',
            ...pos,
            padding: '6px 10px',
            background: 'var(--surface-inverse)',
            color: 'var(--neutral-0)',
            fontFamily: 'var(--font-body)',
            fontSize: 'var(--text-xs)',
            fontWeight: 600,
            borderRadius: 'var(--radius-md)',
            whiteSpace: 'nowrap',
            boxShadow: 'var(--shadow-md)',
            animation: 'wm-fade-in-up var(--duration-fast) var(--ease-soft)',
            zIndex: 20,
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
