import React from 'react';

// The tone is one edge and nothing else — the body stays the card, so a transient floating over a
// page is never see-through.
const tones = {
  // The plain transient: a room's one voice, saying what happened and nothing about how to feel.
  neutral: 'var(--border-strong)',
  success: 'var(--color-success)',
  info: 'var(--color-info)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
};

// `action` is `{ label, onClick }` — the take-back a transient carries while its window is open. It
// is drawn in the brand ink and never in the alarm's: an undo is not a warning.
export function Toast({ children, tone = 'success', onClose, action = null }) {
  const edge = tones[tone] || tones.success;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '11px 11px 11px 16px',
        borderRadius: 'var(--radius-lg)',
        background: 'var(--surface-card)',
        borderLeft: `3px solid ${edge}`,
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
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          style={{
            flex: 'none',
            minHeight: 34,
            padding: '0 12px',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            background: 'transparent',
            color: 'var(--color-brand)',
            font: 'inherit',
            fontWeight: 800,
            cursor: 'pointer',
          }}
        >
          {action.label}
        </button>
      )}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          title="Dismiss"
          style={{
            flex: 'none',
            width: 34,
            height: 34,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            borderRadius: 'var(--radius-full)',
            background: 'none',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      )}
    </div>
  );
}
