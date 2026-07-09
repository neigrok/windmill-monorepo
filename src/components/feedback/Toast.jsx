import React from 'react';

const tones = {
  success: { border: 'var(--color-success)', bg: 'var(--color-success-bg)' },
  info: { border: 'var(--color-info)', bg: 'var(--color-info-bg)' },
  warning: { border: 'var(--color-warning)', bg: 'var(--color-warning-bg)' },
  danger: { border: 'var(--color-danger)', bg: 'var(--color-danger-bg)' },
};

export function Toast({ children, tone = 'success', onClose }) {
  const t = tones[tone] || tones.success;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--surface-card)',
        borderLeft: `3px solid ${t.border}`,
        boxShadow: 'var(--shadow-lg)',
        fontFamily: 'var(--font-body)',
        fontSize: 'var(--text-sm)',
        fontWeight: 600,
        color: 'var(--text-primary)',
        animation: 'wm-fade-in-up var(--duration-base) var(--ease-soft)',
        minWidth: 240,
      }}
    >
      <span style={{ flex: 1 }}>{children}</span>
      {onClose && (
        <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', opacity: 0.5, fontSize: 16 }}>
          ×
        </button>
      )}
    </div>
  );
}
