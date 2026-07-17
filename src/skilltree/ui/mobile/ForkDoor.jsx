// The fork "door" (X5 §S4) — the one place the share page's single verb resolves. On
// phone it rises as a bottom-edge sheet over a scrim; on tablet it is the app's centered
// Dialog. The X4 "one door": a signed-in visitor forks instantly — one button, straight
// into the copy — and signed out the email decides: the magic link carries the pending
// fork and the backend completes it when the link is claimed. Held to the SignInDialog
// standard: validated address, guarded sends, every failure ends in a next step.

import React, { useEffect, useRef, useState } from 'react';
import { Button, Input, Dialog } from '../../../components';
import { requestMagicLink } from '../../auth/AuthClient.js';
import { forkTree } from '../../persistence/TreeRegistry.js';
import { FORKED_FROM_DEMO_KEY } from '../../demo/demoStage.js';
import { track } from '../../../telemetry/beacon.js';

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function ForkDoor({ open, tablet = false, treeId, signedIn = false, demo = false, onClose, onSubmit, stepCount = null }) {
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | sending | sent | rate_limited | unreachable
  const [typo, setTypo] = useState(false);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false); // the signed-in fork in flight — navigation is coming
  const [forkError, setForkError] = useState(null); // 'unauthenticated' | 'failed'
  const inflight = useRef(false);

  const reduced = prefersReducedMotion();

  useEffect(() => {
    if (!open) {
      setShown(false);
      return undefined;
    }
    setEmail('');
    setPhase('idle');
    setTypo(false);
    setBusy(false);
    setForkError(null);
    inflight.current = false;
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Never dismiss mid-fork: the fork is already committed server-side and the
  // navigation lands in a beat — closing here would teleport the user later.
  const close = () => {
    if (!busy) onClose?.();
  };

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, busy]);

  if (!open) return null;

  async function submitEmail(e) {
    e?.preventDefault();
    const address = email.trim();
    if (!EMAIL_SHAPE.test(address)) {
      setTypo(true);
      return;
    }
    if (inflight.current) return;
    inflight.current = true;
    setPhase('sending');
    track('fork_attempt', { mode: 'email' });
    try {
      await requestMagicLink(address, { forkOf: treeId });
      setPhase('sent');
      onSubmit?.();
    } catch (err) {
      if (err?.code === 'invalid_email') {
        setPhase('idle');
        setTypo(true);
      } else if (err?.code === 'rate_limited') {
        setPhase('rate_limited');
      } else {
        setPhase('unreachable');
      }
    } finally {
      inflight.current = false;
    }
  }

  function submitFork() {
    if (busy) return;
    setBusy(true);
    setForkError(null);
    track('fork_attempt', { mode: 'instant' });
    forkTree(treeId)
      .then(({ treeId: forkedId }) => {
        track('fork_claim', { mode: 'instant' });
        // Forking from the demo (F4 §05): leave a one-shot note so the fresh copy's arrival
        // re-plant speaks "Forked — 17 steps planted" — now you're the actor, so it toasts.
        if (demo) { try { sessionStorage.setItem(FORKED_FROM_DEMO_KEY, '1'); } catch { /* ignore */ } }
        // A fork crosses the read-only → editor boundary; land in the copy on a clean
        // page load so the scene is born in editor mode, not retrofitted into it.
        window.location.hash = `#/app/${forkedId}`;
        window.location.reload();
      })
      .catch((err) => {
        setBusy(false);
        setForkError(err?.code === 'unauthenticated' ? 'unauthenticated' : 'failed');
      });
  }

  function backToForm() {
    setPhase('idle');
    setTypo(false);
  }

  const stepsPhrase = stepCount ? `all ${stepCount} steps` : 'every step';
  const instantFork = signedIn && forkError !== 'unauthenticated';

  const content = phase === 'sent' ? (
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
        We sent a link to {email.trim()}. It works once, lasts 15 minutes, and finishes the fork — the copy lands in your trees.
      </p>
      <div style={{ display: 'grid', justifyContent: 'center', marginTop: 14 }}>
        <Button variant="ghost" size="sm" onClick={backToForm}>Use a different email</Button>
      </div>
    </div>
  ) : phase === 'rate_limited' ? (
    <div>
      <h2 style={TITLE_STYLE}>That's a few links in a row</h2>
      <p style={COPY_STYLE}>
        Check your spam folder first — or try again in 10 minutes. Only the newest link carries this fork.
      </p>
      <div style={{ display: 'grid', marginTop: 14 }}>
        <Button variant="ghost" size="sm" onClick={backToForm}>Use a different email</Button>
      </div>
    </div>
  ) : phase === 'unreachable' ? (
    <div>
      <h2 style={TITLE_STYLE}>Can't reach windmill.works</h2>
      <p style={COPY_STYLE}>Nothing was sent — try again in a moment.</p>
      <div style={{ display: 'grid', marginTop: 14 }}>
        <Button variant="ghost" size="sm" onClick={backToForm}>Back</Button>
      </div>
    </div>
  ) : instantFork ? (
    <div>
      <h2 style={TITLE_STYLE}>Make it yours</h2>
      <p style={COPY_STYLE}>
        Forking plants a copy of {stepsPhrase} in your trees — progress cleared, yours to grow.
      </p>
      <div style={{ display: 'grid', marginTop: 18 }}>
        <Button variant="primary" size="lg" onClick={submitFork} disabled={busy}>
          {busy ? 'Forking…' : 'Fork this tree'}
        </Button>
      </div>
      {forkError === 'failed' && (
        <p style={FINE_PRINT_STYLE}>Couldn't fork just now — try again in a moment.</p>
      )}
    </div>
  ) : (
    <form onSubmit={submitEmail}>
      <h2 style={TITLE_STYLE}>Make it yours</h2>
      <p style={COPY_STYLE}>
        Forking plants a copy of {stepsPhrase} in your trees — progress cleared, yours to grow.
      </p>
      {forkError === 'unauthenticated' && (
        <p style={{ ...FINE_PRINT_STYLE, color: 'var(--text-secondary)' }}>
          Your session expired — the email door still works.
        </p>
      )}
      <div style={{ marginTop: 18 }}>
        <Input
          type="email"
          placeholder="you@anywhere.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (typo) setTypo(false);
          }}
        />
      </div>
      {typo && (
        <p style={FINE_PRINT_STYLE}>That address looks unfinished — check the ending.</p>
      )}
      <div style={{ display: 'grid', marginTop: 14 }}>
        <Button type="submit" variant="primary" size="lg" disabled={phase === 'sending'}>
          {phase === 'sending' ? 'Sending…' : 'Email me a link'}
        </Button>
      </div>
      <p style={FINE_PRINT_STYLE}>
        One door — no sign-up, the email decides. The link lands the fork in your trees.
      </p>
    </form>
  );

  if (tablet) {
    return (
      <Dialog open={open} onClose={close} width={420}>
        {content}
      </Dialog>
    );
  }

  return (
    <div
      onClick={close}
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
