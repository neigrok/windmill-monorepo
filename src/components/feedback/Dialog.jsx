import React from 'react';

export function Dialog({ open, onClose, title, children, footer, width = 420 }) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--surface-overlay)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        animation: 'wm-fade-in-up var(--duration-fast) var(--ease-soft)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: width,
          maxWidth: '90vw',
          background: 'var(--surface-card)',
          borderRadius: 'var(--radius-2xl)',
          boxShadow: 'var(--shadow-lg)',
          padding: 'var(--space-8)',
          animation: 'wm-pop-in var(--duration-base) var(--ease-soft)',
        }}
      >
        {title && (
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-xl)', marginBottom: 12 }}>
            {title}
          </div>
        )}
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>
          {children}
        </div>
        {footer && <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>{footer}</div>}
      </div>
    </div>
  );
}
