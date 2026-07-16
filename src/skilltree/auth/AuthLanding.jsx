import React from 'react';
import { Button } from '../../components';
import { track } from '../../telemetry/beacon.js';

// The magic-link URL is ${APP}/#/auth?token=<secret> — the token rides in the
// fragment's query part (location.hash), never location.search, so we split the
// hash on '?' and read it ourselves.
function readTokenFromHash() {
  const hash = window.location.hash || '';
  const query = hash.indexOf('?');
  if (query === -1) return null;
  return new URLSearchParams(hash.slice(query + 1)).get('token');
}

export function AuthLanding({ onVerify, onSignedIn, onExpired, onOpenDoor }) {
  const [status, setStatus] = React.useState('verifying');
  const verified = React.useRef(false);

  React.useEffect(() => {
    if (verified.current) return; // one verify per mount — survives StrictMode's double-run
    verified.current = true;

    const token = readTokenFromHash();
    if (!token) {
      setStatus('expired');
      onExpired?.();
      return;
    }

    let active = true;
    onVerify(token)
      .then(({ user, forkedTree }) => {
        if (!active) return;
        track('sign_in', { forked: !!forkedTree });
        if (forkedTree) track('fork_claim', { mode: 'email' });
        onSignedIn(user, forkedTree);
      })
      .catch(() => {
        if (!active) return;
        setStatus('expired');
        onExpired?.();
      });
    return () => { active = false; };
  }, []);

  if (status === 'expired') {
    return (
      <div style={stage}>
        <div style={column}>
          <h1 style={heading}>That link has expired</h1>
          <p style={subtext}>Links work once and last 15 minutes.</p>
          <div style={{ marginTop: 'var(--space-2)' }}>
            <Button size="lg" onClick={onOpenDoor}>Email me a fresh one</Button>
          </div>
        </div>
      </div>
    );
  }

  // 'verifying' — also the calm cover held through the success handoff, until the
  // integration navigates back to the app and unmounts us. No flash either way.
  return (
    <div style={stage}>
      <div style={{ ...column, gap: 'var(--space-5)' }}>
        <span style={goldDot} />
        <p style={signingText}>Signing you in…</p>
      </div>
    </div>
  );
}

export default AuthLanding;

const stage = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'var(--space-6)',
  background: 'var(--surface-canvas)',
};

const column = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  textAlign: 'center',
  gap: 'var(--space-3)',
  maxWidth: '30rem',
  animation: 'wm-fade-in-up var(--duration-base) var(--ease-soft) both',
};

const goldDot = {
  width: '12px',
  height: '12px',
  borderRadius: 'var(--radius-full)',
  background: 'var(--accent-gold-500)',
  ['--nd-glow']: 'var(--kind-gold-glow)',
  animation: 'wm-ember var(--duration-glow) var(--ease-glow) infinite',
};

const signingText = {
  fontFamily: 'var(--font-display)',
  fontWeight: 'var(--font-weight-semibold)',
  fontSize: 'var(--text-lg)',
  letterSpacing: 'var(--tracking-wide)',
  color: 'var(--text-tertiary)',
};

const heading = {
  fontFamily: 'var(--font-display)',
  fontWeight: 'var(--font-weight-extrabold)',
  fontSize: 'var(--text-3xl)',
  letterSpacing: 'var(--tracking-tight)',
  color: 'var(--text-primary)',
};

const subtext = {
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-base)',
  lineHeight: 'var(--leading-base)',
  color: 'var(--text-secondary)',
};
