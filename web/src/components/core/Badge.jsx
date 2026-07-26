import React from 'react';

const tones = {
  neutral: { bg: 'var(--neutral-100)', fg: 'var(--text-secondary)' },
  brand: { bg: 'var(--color-brand-soft)', fg: 'var(--color-brand-hover)' },
  success: { bg: 'var(--color-success-bg)', fg: 'var(--color-success)' },
  warning: { bg: 'var(--color-warning-bg)', fg: 'var(--accent-gold-600)' },
  danger: { bg: 'var(--color-danger-bg)', fg: 'var(--accent-brick-600)' },
};

export function Badge({ children, tone = 'neutral', dot = false }) {
  const t = tones[tone] || tones.neutral;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '3px 10px',
        borderRadius: 'var(--radius-full)',
        background: t.bg,
        color: t.fg,
        fontFamily: 'var(--font-body)',
        fontSize: 'var(--text-xs)',
        fontWeight: 700,
        letterSpacing: 'var(--tracking-wide)',
        textTransform: 'uppercase',
      }}
    >
      {dot && <span style={{ width: 6, height: 6, borderRadius: 999, background: t.fg }} />}
      {children}
    </span>
  );
}
