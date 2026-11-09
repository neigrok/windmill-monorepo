import React, { useEffect } from 'react';
import { Button } from '../../../design-system';
import { prefersReducedMotion } from '../theme.js';
import { t } from '../i18n/index.js';

const enterAnimation = () =>
  prefersReducedMotion()
    ? 'wm-fade-in var(--duration-base) var(--ease-soft)'
    : 'wm-fade-in-up var(--duration-base) var(--ease-soft)';

export function StatusChip({ children }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 28,
        padding: '0 12px',
        whiteSpace: 'nowrap',
        borderRadius: 'var(--radius-full)',
        background: 'var(--surface-card)',
        border: '1px solid var(--border-subtle)',
        boxShadow: 'var(--shadow-sm)',
        fontFamily: 'var(--font-body)',
        fontSize: 'var(--text-xs)',
        fontWeight: 600,
        color: 'var(--text-secondary)',
        animation: enterAnimation(),
        pointerEvents: 'none',
      }}
    >
      {children}
    </span>
  );
}

export function VisitorNotice({ edits = 0, author = null, onFork, onDismiss, onSignIn }) {
  // Capture + stopPropagation: Esc dismisses this card only, never a node or dialog underneath.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onDismiss?.();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onDismiss]);

  return (
    <div
      role="status"
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)',
        transform: 'translateX(-50%)',
        width: 'min(420px, calc(100vw - 32px))',
        padding: '18px 20px',
        borderRadius: 'var(--radius-xl)',
        background: 'var(--surface-card)',
        border: '1px solid var(--border-subtle)',
        boxShadow: 'var(--shadow-lg)',
        fontFamily: 'var(--font-body)',
        zIndex: 30,
        animation: enterAnimation(),
      }}
    >
      <p
        style={{
          margin: 0,
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: 'var(--text-base)',
          color: 'var(--text-primary)',
        }}
      >
        {author ? t('roadmap.honesty.belongsTo', { author }) : t('roadmap.honesty.belongsToSomeone')}
      </p>
      {edits > 0 && (
        <p style={{ margin: '8px 0 0', fontSize: 'var(--text-sm)', lineHeight: 1.5, color: 'var(--text-secondary)' }}>
          {t('roadmap.honesty.safe', { count: edits, changes: <strong>{t('roadmap.honesty.changes', { count: edits })}</strong> })}
        </p>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
        <Button variant="primary" size="md" onClick={onFork}>{t('roadmap.honesty.fork')}</Button>
        <Button variant="ghost" size="md" onClick={onDismiss}>{t('roadmap.honesty.later')}</Button>
      </div>
      {onSignIn && (
        <button
          type="button"
          onClick={onSignIn}
          style={{
            marginTop: 12,
            padding: 0,
            border: 'none',
            background: 'none',
            fontFamily: 'inherit',
            fontSize: 'var(--text-xs)',
            fontWeight: 600,
            color: 'var(--text-tertiary)',
            textDecoration: 'underline',
            cursor: 'pointer',
          }}
        >
          {t('roadmap.honesty.signIn')}
        </button>
      )}
    </div>
  );
}
