// The fork "door" (X5 §S4) — the one place the page's single verb resolves. On phone
// it rises as a bottom-edge sheet over a scrim; on tablet it is the app's centered
// Dialog. Either way the content is identical: an invitation, an email field, and one
// button. Submitting is stubbed — it swaps to a "check your email" state and tells the
// parent via `onSubmit` (the parent may toast); it touches no network. The X4 "one
// door": no sign-up, the email decides, and a signed-in actor forks instantly.

import React, { useEffect, useState } from 'react';
import { Button, Input, Dialog } from '../../../components';
import { requestMagicLink } from '../../auth/AuthClient.js';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function ForkDoor({ open, tablet = false, onClose, onSubmit, stepCount = null }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [shown, setShown] = useState(false);

  const reduced = prefersReducedMotion();

  useEffect(() => {
    if (!open) {
      setShown(false);
      return undefined;
    }
    setSent(false);
    setEmail('');
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = () => {
    // Fire the one-door magic link (X6, same door as the desktop seat). A failure never
    // blocks the sent state — the worst case ends in a next step, and the backend
    // completes the fork once the link is claimed (X5).
    requestMagicLink(email).catch(() => {});
    setSent(true);
    onSubmit?.();
  };

  const stepsPhrase = stepCount ? `all ${stepCount} steps` : 'every step';
  const content = sent ? (
    <div style={{ textAlign: 'center' }}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 56,
          height: 56,
          borderRadius: 'var(--radius-full)',
          background: 'var(--color-brand-soft)',
          color: 'var(--color-brand)',
        }}
      >
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="5" width="18" height="14" rx="2.5" />
          <path d="M3.5 7 L12 13 L20.5 7" />
        </svg>
      </div>
      <h2 style={{ ...TITLE_STYLE, marginTop: 14 }}>Check your email</h2>
      <p style={{ ...COPY_STYLE, textAlign: 'center' }}>
        The link finishes the fork — it'll be waiting in your gallery.
      </p>
    </div>
  ) : (
    <div>
      <h2 style={TITLE_STYLE}>Make it yours</h2>
      <p style={COPY_STYLE}>
        Forking plants a copy of {stepsPhrase} in your gallery — progress cleared, yours to grow.
      </p>
      <div style={{ marginTop: 18 }}>
        <Input
          type="email"
          placeholder="you@anywhere.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div style={{ display: 'grid', marginTop: 14 }}>
        <Button variant="primary" size="lg" onClick={submit}>
          Email me a link
        </Button>
      </div>
      <p style={FINE_PRINT_STYLE}>
        One door — no sign-up, the email decides. Already signed in? The fork is instant.
      </p>
    </div>
  );

  if (tablet) {
    return (
      <Dialog open={open} onClose={onClose} width={420}>
        {content}
      </Dialog>
    );
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'flex-end',
        background: 'var(--surface-overlay)',
        opacity: shown ? 1 : 0,
        transition: 'opacity var(--duration-base) var(--ease-soft)',
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          background: 'var(--surface-card)',
          borderTopLeftRadius: 'var(--radius-xl)',
          borderTopRightRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-lg)',
          padding: 'var(--space-5) var(--space-5) calc(env(safe-area-inset-bottom, 0px) + var(--space-6))',
          transform: reduced ? 'none' : shown ? 'translateY(0)' : 'translateY(100%)',
          transition: reduced
            ? 'opacity var(--duration-base) var(--ease-soft)'
            : 'transform var(--duration-base) var(--ease-soft)',
          willChange: 'transform',
        }}
      >
        <div
          style={{
            width: 40,
            height: 5,
            margin: '0 auto 14px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--border-default)',
          }}
        />
        {content}
      </div>
    </div>
  );
}

const TITLE_STYLE = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 'var(--text-xl)',
  color: 'var(--text-primary)',
};

const COPY_STYLE = {
  margin: '10px 0 0',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-base)',
  lineHeight: 1.5,
  color: 'var(--text-secondary)',
};

const FINE_PRINT_STYLE = {
  margin: '14px 0 0',
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-xs)',
  lineHeight: 1.5,
  color: 'var(--text-tertiary)',
};

export default ForkDoor;
