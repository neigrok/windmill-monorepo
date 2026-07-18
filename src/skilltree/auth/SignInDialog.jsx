import React from 'react';
import { Dialog, Input, Button, Icon } from '../../components';

// One door, keyed by email. This component owns its own little state machine —
// idle → sending → wait, with error branches that never turn the door red. The
// integration hands us onSend (requestMagicLink); we only speak in props.
//
// Copy is verbatim from auth.md §7. Every failure ends in a next step.

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignInDialog({ open, onClose, onSend, resume = null }) {
  const [email, setEmail] = React.useState('');
  const [phase, setPhase] = React.useState('idle'); // idle | sending | wait | error
  const [errorCode, setErrorCode] = React.useState(null); // rate_limited | unreachable
  const [showSending, setShowSending] = React.useState(false); // the 800ms gate
  const [typo, setTypo] = React.useState(false); // gold field ring, never red
  const [canResend, setCanResend] = React.useState(false); // the 30s gate

  const inflight = React.useRef(false);
  const sendGate = React.useRef(null);
  const resendGate = React.useRef(null);

  // Reset the machine every time the door opens fresh — unless a `resume` record
  // ({ email, at }) rides in: then the door reopens on its wait panel, with the
  // Resend gate carried over from when that link actually went out.
  React.useEffect(() => {
    if (!open) return;
    setErrorCode(null);
    setShowSending(false);
    setTypo(false);
    inflight.current = false;
    clearTimeout(sendGate.current);
    clearTimeout(resendGate.current);
    if (resume?.email && resume?.at) {
      setEmail(resume.email);
      setPhase('wait');
      const remaining = resume.at + 30000 - Date.now();
      if (remaining <= 0) { setCanResend(true); return; }
      setCanResend(false);
      resendGate.current = setTimeout(() => setCanResend(true), remaining);
      return;
    }
    setEmail('');
    setPhase('idle');
    setCanResend(false);
  }, [open]);

  React.useEffect(() => () => {
    clearTimeout(sendGate.current);
    clearTimeout(resendGate.current);
  }, []);

  // The one path a link takes out the door. Guarded by a ref so a fast double
  // click can't fire twice while the button still reads "Email me a link".
  async function send(address) {
    if (inflight.current) return;
    inflight.current = true;
    setPhase('sending');
    setShowSending(false);
    setTypo(false);
    setCanResend(false);
    clearTimeout(sendGate.current);
    sendGate.current = setTimeout(() => setShowSending(true), 800);
    try {
      await onSend(address);
      setPhase('wait');
      clearTimeout(resendGate.current);
      resendGate.current = setTimeout(() => setCanResend(true), 30000);
    } catch (err) {
      const code = err?.code;
      if (code === 'invalid_email') { setPhase('idle'); setTypo(true); }
      else if (code === 'rate_limited') { setPhase('error'); setErrorCode('rate_limited'); }
      else { setPhase('error'); setErrorCode('unreachable'); } // the only brick
    } finally {
      clearTimeout(sendGate.current);
      setShowSending(false);
      inflight.current = false;
    }
  }

  function submit(e) {
    e?.preventDefault();
    const address = email.trim();
    if (!EMAIL_SHAPE.test(address)) { setTypo(true); return; } // no send on a half address
    send(address);
  }

  function backToForm() {
    clearTimeout(resendGate.current);
    setPhase('idle');
    setErrorCode(null);
    setCanResend(false);
    setTypo(false);
  }

  return (
    <Dialog open={open} onClose={onClose} width={400}>
      <div style={wordmark}>
        <span>Windmill</span>
      </div>

      {(phase === 'idle' || phase === 'sending') && (
        <form onSubmit={submit} style={column}>
          <h2 style={title}>Sign in</h2>
          <p style={oneDoor}>New here? Same door — your account is created the first time.</p>

          <div style={{ ...field, boxShadow: typo ? GOLD_RING : 'none' }}>
            <Input
              type="email"
              placeholder="you@example.com"
              value={email}
              autoFocus
              onChange={(e) => { setEmail(e.target.value); if (typo) setTypo(false); }}
            />
          </div>
          {typo && <p style={typoLine}>That address looks unfinished — check the ending.</p>}

          {phase === 'sending' && showSending ? (
            <div style={sending}>
              <span style={goldDot} />
              <span>Sending…</span>
            </div>
          ) : (
            <Button type="submit">Email me a link</Button>
          )}

          <Button variant="ghost" disabled>Continue with Google</Button>

          <p style={reassurance}>No password. Signed out, Windmill still works — your trees live on this device.</p>
        </form>
      )}

      {phase === 'wait' && (
        <div style={column}>
          <h2 style={panelTitle}>Check your email</h2>
          <p style={panelBody}>We sent a link to {email}. It works once and lasts 15 minutes.</p>
          <div style={panelActions}>
            <Button variant="ghost" size="sm" onClick={backToForm}>Use a different email</Button>
            {canResend && <Button variant="secondary" size="sm" onClick={() => send(email.trim())}>Resend</Button>}
          </div>
        </div>
      )}

      {phase === 'error' && errorCode === 'rate_limited' && (
        <div style={column}>
          <h2 style={panelTitle}>That's a few links in a row</h2>
          <p style={panelBody}>Check your spam folder first — or try again in 10 minutes.</p>
          <div style={panelActions}>
            <Button variant="ghost" size="sm" onClick={backToForm}>Use a different email</Button>
          </div>
        </div>
      )}

      {phase === 'error' && errorCode === 'unreachable' && (
        <div style={column}>
          <div style={brickHead}>
            <Icon name="wifi" size={18} color="var(--color-danger)" />
            <h2 style={brickTitle}>Can't reach windmill.works</h2>
          </div>
          <p style={panelBody}>Your trees are safe on this device.</p>
          <div style={panelActions}>
            <Button variant="secondary" size="sm" onClick={() => send(email.trim())}>Retry</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export default SignInDialog;

const wordmark = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  fontFamily: 'var(--font-display)',
  fontWeight: 'var(--font-weight-extrabold)',
  fontSize: 'var(--text-sm)',
  letterSpacing: 'var(--tracking-wide)',
  color: 'var(--accent-gold-600)',
  marginBottom: 'var(--space-4)',
};

const column = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
};

const title = {
  fontFamily: 'var(--font-display)',
  fontWeight: 'var(--font-weight-bold)',
  fontSize: 'var(--text-2xl)',
  letterSpacing: 'var(--tracking-tight)',
  color: 'var(--text-primary)',
};

const oneDoor = {
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-sm)',
  lineHeight: 'var(--leading-sm)',
  color: 'var(--text-secondary)',
  marginBottom: 'var(--space-1)',
};

const field = {
  borderRadius: 'var(--radius-lg)',
  transition: 'box-shadow var(--duration-fast) var(--ease-standard)',
};

const GOLD_RING = '0 0 0 3px rgba(196, 151, 47, 0.40)';

const typoLine = {
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-xs)',
  color: 'var(--color-warning)',
  marginTop: 'calc(-1 * var(--space-1))',
};

// The 800ms breathing gold dot — same ember clock as the landing's dot.
const sending = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--space-2)',
  padding: '11px 20px',
  fontFamily: 'var(--font-body)',
  fontWeight: 'var(--font-weight-bold)',
  fontSize: 'var(--text-base)',
  color: 'var(--text-secondary)',
};

const goldDot = {
  width: '10px',
  height: '10px',
  borderRadius: 'var(--radius-full)',
  background: 'var(--accent-gold-500)',
  ['--nd-glow']: 'var(--kind-gold-glow)',
  animation: 'wm-ember var(--duration-glow) var(--ease-glow) infinite',
};

const reassurance = {
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-xs)',
  lineHeight: 'var(--leading-sm)',
  color: 'var(--text-tertiary)',
  textAlign: 'center',
  marginTop: 'var(--space-1)',
};

const panelTitle = {
  fontFamily: 'var(--font-display)',
  fontWeight: 'var(--font-weight-bold)',
  fontSize: 'var(--text-lg)',
  color: 'var(--text-primary)',
};

const panelBody = {
  fontFamily: 'var(--font-body)',
  fontSize: 'var(--text-sm)',
  lineHeight: 'var(--leading-sm)',
  color: 'var(--text-secondary)',
};

const panelActions = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  marginTop: 'var(--space-2)',
};

const brickHead = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
};

const brickTitle = {
  fontFamily: 'var(--font-display)',
  fontWeight: 'var(--font-weight-bold)',
  fontSize: 'var(--text-lg)',
  color: 'var(--color-danger)',
};
