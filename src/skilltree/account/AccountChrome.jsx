// The plain account chrome — the frame the account surfaces share: /connect and
// /settings. One fixed, centered card on the canvas, its head a wordmark and the
// signed-in seat (a signed-out visitor gets the "Back to Windmill" door instead).
// Purely presentational: it reads who this tab is straight from useAuth so both pages
// render an identical head, and hands the page its own body as children. The margin:auto
// centering keeps a short card centered while letting a tall one (settings) scroll from
// the top instead of clipping.

import React from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { Avatar } from '../../components';
import { PlaceStore } from '../persistence/PlaceStore.js';

// Return to work, not a lobby (anon-first-tree F6): the back door re-opens the last
// tree this device stood in, matching App.landingHash.
function backHash() {
  const place = new PlaceStore().load();
  return place?.treeId ? `#/app/${place.treeId}` : '#/app';
}

export function AccountChrome({ width = 460, children }) {
  const { user, status } = useAuth();
  const signedIn = status === 'signed-in' && Boolean(user);
  const name = signedIn ? (user.name?.trim() || user.email) : '';

  return (
    <div style={shell}>
      <div style={{ ...card, width }}>
        <div style={head}>
          <span style={mark}>Windmill</span>
          <a href={backHash()} style={backLink}>Back to Windmill</a>
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
