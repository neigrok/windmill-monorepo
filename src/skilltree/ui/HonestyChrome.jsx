// The honesty chrome (share-hardening): StatusChip is the neutral pill that outlives
// any toast — a truth that doesn't expire; VisitorNotice is the bottom-center card for
// a tree that isn't yours. A card, never a modal: the canvas stays live behind it,
// Esc or "Maybe later" dismisses, and focus is never stolen.

import React, { useEffect } from 'react';
import { Button } from '../../components';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  // Capture + stopPropagation: Esc dismisses this card and nothing else — the same
  // press must not also deselect a node or close a dialog underneath.
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
        {author ? `This tree belongs to ${author}.` : 'This tree belongs to someone else.'}
      </p>
      {edits > 0 && (
        <p style={{ margin: '8px 0 0', fontSize: 'var(--text-sm)', lineHeight: 1.5, color: 'var(--text-secondary)' }}>
          Your <strong>{edits} change{edits === 1 ? '' : 's'}</strong> {edits === 1 ? 'is' : 'are'} safe
          on this device.
        </p>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
        <Button variant="primary" size="md" onClick={onFork}>Fork this tree</Button>
        <Button variant="ghost" size="md" onClick={onDismiss}>Maybe later</Button>
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
          This yours? Sign in
        </button>
      )}
    </div>
  );
}
