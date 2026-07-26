// The plain account chrome — the frame the account surfaces share: /connect and
// /settings. One fixed, centered card on the canvas, its head a wordmark and the
// signed-in seat (a signed-out visitor gets the "Back to Windmill" door instead).
// Purely presentational: it reads who this tab is straight from useAuth so both pages
// render an identical head, and hands the page its own body as children. The margin:auto
// centering keeps a short card centered while letting a tall one (settings) scroll from
// the top instead of clipping.

import React from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { Avatar } from '../../design-system';

// Product-neutral account frame: where "back/home" goes is the shell's call, not this
// frame's. The shell hands in `backHash` from the active product's home (see shell/products.js);
// the account surfaces (/settings, /connect) pass it down, so notes/gym can slot in unchanged.
export function AccountChrome({ width = 460, backHash = '#/app', children }) {
  const { user, status } = useAuth();
  const signedIn = status === 'signed-in' && Boolean(user);
  const name = signedIn ? (user.name?.trim() || user.email) : '';

  // Esc leaves the account surface for the app — the keyboard twin of the "Back to Windmill"
  // door, so /settings and /connect aren't a dead end. A bubble listener, so an open Dialog's
  // capture-phase Esc still wins (closes the dialog first); skipped while typing in a field so
  // Esc mid-edit stays the field's own, not a navigation that discards the edit.
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      window.location.hash = backHash;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [backHash]);

  return (
    <div style={shell}>
      <div style={{ ...card, width }}>
        <div style={head}>
          <span style={mark}>Windmill</span>
          <a href={backHash} style={backLink} title="Back to Windmill (Esc)">Back to Windmill</a>
          {signedIn && <Avatar name={name} size={22} />}
        </div>
        {children}
      </div>
    </div>
  );
}

export default AccountChrome;

const shell = {
  position: 'fixed', inset: 0, display: 'flex', justifyContent: 'center', overflow: 'auto',
  padding: 'var(--space-4)',
  background: 'var(--surface-canvas)', fontFamily: 'var(--font-body)', color: 'var(--text-primary)',
};
const card = {
  maxWidth: '100%', boxSizing: 'border-box', margin: 'auto', background: 'var(--surface-card)',
  border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-lg)',
  padding: '18px 20px 18px',
};
const head = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 };
const mark = { fontFamily: 'var(--font-display)', fontSize: '14px', fontWeight: 800, flex: 1 };
const backLink = { fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-link)', textDecoration: 'none' };
