// A signed-in visitor forks instantly; signed out, the magic link carries the pending fork and the
// backend completes it when the link is claimed.

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, Input, Dialog } from '../../../design-system';
import { useDialogFocus } from '../../../design-system/feedback/Dialog.jsx';
import { requestMagicLink } from '../../../shell/auth/AuthClient.js';
import { forkTree } from '../persistence/TreeRegistry.js';
import { reportUnexpectedFailure } from '../reportFailure.js';
import { noteForked } from '../persistence/ViewPrefs.js';
import { prefersReducedMotion } from '../theme.js';
import { track } from '../../../telemetry/beacon.js';
import { t } from '../i18n/index.js';
import './fork-door.css';

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ForkDoor({ open, presentation = 'sheet', treeId, signedIn = false, onClose, onSubmit, stepCount = null }) {
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | sending | sent | rate_limited | unreachable
  const [typo, setTypo] = useState(false);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false); // the signed-in fork in flight — navigation is coming
  const [forkError, setForkError] = useState(null); // 'unauthenticated' | 'failed'
  const inflight = useRef(false);
  const sheetRef = useRef(null);
  const titleId = useId();
  const dialog = presentation === 'dialog';

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

  // Never dismiss mid-fork: the fork is already committed server-side.
  const close = useCallback(() => {
    if (!busy) onClose?.();
  }, [busy, onClose]);

  const trapTab = useDialogFocus({
    open: open && !dialog, cardRef: sheetRef, onClose: close, preserveOutsideFocus: true, recoverFocus: true,
  });

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
        track('fork_attempt', { mode: 'email', outcome: 'invalid' });
        setPhase('idle');
        setTypo(true);
      } else if (err?.code === 'rate_limited') {
        track('fork_attempt', { mode: 'email', outcome: 'rate_limited' });
        setPhase('rate_limited');
      } else {
        track('fork_attempt', { mode: 'email', outcome: 'failed' });
        reportUnexpectedFailure('roadmap-fork', err);
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
        noteForked();
        // Rewrite the URL to the hash route, then reload: a /t/:id pathname would stay pinned read-only,
        // and the scene must be born in editor mode.
        window.history.replaceState(null, '', `/#/app/${forkedId}`);
        window.location.reload();
      })
      .catch((err) => {
        setBusy(false);
        const unauthenticated = err?.code === 'unauthenticated';
        track('fork_attempt', { mode: 'instant', outcome: unauthenticated ? 'unauthenticated' : 'failed' });
        if (!unauthenticated) reportUnexpectedFailure('roadmap-fork', err);
        setForkError(unauthenticated ? 'unauthenticated' : 'failed');
      });
  }

  function backToForm() {
    setPhase('idle');
    setTypo(false);
  }

  const plantsCopy = stepCount ? t('roadmap.fork.plantsAll', { count: stepCount }) : t('roadmap.fork.plantsEvery');
  const instantFork = signedIn && forkError !== 'unauthenticated';
  const centered = !dialog && instantFork;
  const titleStyle = centered ? { ...TITLE_STYLE, fontSize: 22, textAlign: 'center' } : TITLE_STYLE;
  const contentGap = centered ? 12 : 14;
  const copyStyle = {
    ...COPY_STYLE,
    margin: `${contentGap}px 0 0`,
    fontSize: centered ? 'var(--text-sm)' : 'var(--text-base)',
    textAlign: centered ? 'center' : undefined,
  };

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
      <h2 id={titleId} style={{ ...TITLE_STYLE, marginTop: 14 }}>{t('roadmap.fork.sentTitle')}</h2>
      <p style={{ ...COPY_STYLE, textAlign: 'center' }}>
        {t('roadmap.fork.sentBody', { email: email.trim() })}
      </p>
      <div style={{ display: 'grid', justifyContent: 'center', marginTop: 14 }}>
        <Button variant="ghost" size="sm" onClick={backToForm}>{t('roadmap.fork.differentEmail')}</Button>
      </div>
    </div>
  ) : phase === 'rate_limited' ? (
    <div>
      <h2 id={titleId} style={TITLE_STYLE}>{t('roadmap.fork.rateLimitedTitle')}</h2>
      <p style={COPY_STYLE}>
        {t('roadmap.fork.rateLimitedBody')}
      </p>
      <div style={{ display: 'grid', marginTop: 14 }}>
        <Button variant="ghost" size="sm" onClick={backToForm}>{t('roadmap.fork.differentEmail')}</Button>
      </div>
    </div>
  ) : phase === 'unreachable' ? (
    <div>
      <h2 id={titleId} style={TITLE_STYLE}>{t('roadmap.fork.unreachableTitle')}</h2>
      <p style={COPY_STYLE}>{t('roadmap.fork.unreachableBody')}</p>
      <div style={{ display: 'grid', marginTop: 14 }}>
        <Button variant="ghost" size="sm" onClick={backToForm}>{t('roadmap.common.back')}</Button>
      </div>
    </div>
  ) : instantFork ? (
    <div>
      <h2 id={titleId} style={titleStyle}>{t('roadmap.fork.title')}</h2>
      <p style={copyStyle}>
        {plantsCopy}
      </p>
      <div style={{ display: 'grid', marginTop: contentGap }}>
        <Button variant="primary" size="lg" onClick={submitFork} disabled={busy}>
          {busy ? t('roadmap.fork.forking') : t('roadmap.fork.submit')}
        </Button>
      </div>
      {forkError === 'failed' && (
        <p style={FINE_PRINT_STYLE}>{t('roadmap.fork.failed')}</p>
      )}
    </div>
  ) : (
    <form onSubmit={submitEmail}>
      <h2 id={titleId} style={titleStyle}>{t('roadmap.fork.title')}</h2>
      <p style={copyStyle}>
        {plantsCopy}
      </p>
      {forkError === 'unauthenticated' && (
        <p style={{ ...FINE_PRINT_STYLE, color: 'var(--text-secondary)' }}>
          {t('roadmap.fork.sessionExpired')}
        </p>
      )}
      <div style={{ marginTop: contentGap }}>
        <Input
          type="email"
          placeholder={t('roadmap.fork.emailPlaceholder')}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (typo) setTypo(false);
          }}
        />
      </div>
      {typo && (
        <p style={FINE_PRINT_STYLE}>{t('roadmap.fork.typo')}</p>
      )}
      <div style={{ display: 'grid', marginTop: 14 }}>
        <Button type="submit" variant="primary" size="lg" disabled={phase === 'sending'}>
          {phase === 'sending' ? t('roadmap.fork.sending') : t('roadmap.fork.emailMe')}
        </Button>
      </div>
      <p style={FINE_PRINT_STYLE}>
        {t('roadmap.fork.oneDoor')}
      </p>
    </form>
  );

  if (dialog) {
    return (
      <Dialog open={open} onClose={close} labelledBy={titleId} width={406} padding="28px" preserveOutsideFocus>
        <div style={{ paddingTop: 28 }}>{content}</div>
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
        ref={sheetRef}
        className="st-fork-sheet"
        tabIndex={-1}
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        onKeyDown={trapTab}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          background: 'var(--surface-card)',
          borderTopLeftRadius: 'var(--radius-2xl)',
          borderTopRightRadius: 'var(--radius-2xl)',
          boxShadow: 'var(--shadow-lg)',
          padding: 'var(--space-6) var(--space-4) calc(env(safe-area-inset-bottom, 0px) + var(--space-6))',
          maxHeight: '90dvh',
          overflowY: 'auto',
          transform: reduced ? 'none' : shown ? 'translateY(0)' : 'translateY(100%)',
          transition: reduced
            ? 'opacity var(--duration-base) var(--ease-soft)'
            : 'transform var(--duration-base) var(--ease-soft)',
          willChange: 'transform',
        }}
      >
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
