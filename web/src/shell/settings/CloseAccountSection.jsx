// Settings · Close your account — the account's own door, and the last thing on the page.
//
// It lives in the shell rather than in a product because that is what it acts on. Until 2026-08-07
// it was half of the roadmap's "Your data" section, which is how it came to describe one product's
// data while closing an account that also holds journal pages and gym sessions. The rule that
// replaces that, and which gym's own settings section already states out loud, is: a product owns
// its EXPORT, the account owns its CLOSE, and no product may grow a second door that closes it.
//
// No danger-zone theater. The row is quiet until it is opened, the deal is stated plainly
// (accountClosure.js, which is also where the reasoning behind every line is written down), and the
// confirmation is typing your own email — which catches the wrong-account case that "type DELETE"
// never does. Its button is the one brick in all of settings.

import React, { useState } from 'react';
import { Button, Input } from '../../design-system';
import { useAuth } from '../auth/AuthProvider.jsx';
import { closeAccount } from '../auth/AccountClient.js';
import { PRODUCTS } from '../products.js';
import { closingDeal } from './accountClosure.js';
import { Section, styles } from './Section.jsx';

// Every registered product, open or not: the account holds a pre-open product's data just the same,
// and a consent screen that listed only the rooms with a door on the web would be quietly narrower
// than the thing the button does.
const DEAL = closingDeal(PRODUCTS.map((product) => product.label));

export function CloseAccountSection() {
  const { user, signOut } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState(false);
  const [closeError, setCloseError] = useState(null);

  const emailMatches = confirmEmail.trim().toLowerCase() === user.email.toLowerCase();

  const confirmClose = async () => {
    if (!emailMatches || closing) return;
    setClosing(true);
    setCloseError(null);
    try {
      await closeAccount();
      setClosed(true);
      await signOut();
      setTimeout(() => { window.location.hash = '#/'; }, 1800);
    } catch {
      setClosing(false);
      setCloseError("Couldn't close your account just now — try again.");
    }
  };

  // The close is done. The server's reply carries a `closingOn` date, and this screen deliberately
  // does not render it: nothing on the server enforces that date — signing in revives a closed
  // account whenever it happens (AuthService.cpp `revived()`), and no job ever removes the rows. A
  // date printed here would be the one thing on the page nobody keeps.
  if (closed) {
    return (
      <Section title="Close your account">
        <p style={{ ...styles.primaryText, whiteSpace: 'normal' }}>Closed. Every device is signed out.</p>
        <p style={{ ...styles.calmLine, marginTop: 4 }}>Sign in again whenever you want it back.</p>
      </Section>
    );
  }

  return (
    <Section title="Close your account">
      {!expanded ? (
        <button type="button" style={openRow} onClick={() => setExpanded(true)}>Close my account</button>
      ) : (
        <div style={openBlock}>
          <ul style={dealList}>
            {DEAL.map((line) => <li key={line} style={dealItem}>{line}</li>)}
          </ul>
          <p style={styles.fieldLabel}>Type your email to confirm</p>
          <div style={{ maxWidth: 280 }}>
            <Input
              type="email"
              value={confirmEmail}
              placeholder={user.email}
              onChange={(e) => { setConfirmEmail(e.target.value); if (closeError) setCloseError(null); }}
            />
          </div>
          {closeError && <p style={{ ...styles.metaText, color: 'var(--color-danger)' }}>{closeError}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Button variant="danger" size="sm" disabled={!emailMatches || closing} onClick={confirmClose}>
              {closing ? 'Closing…' : 'Close my account'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => { setExpanded(false); setConfirmEmail(''); setCloseError(null); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

export default CloseAccountSection;

const openRow = {
  border: 'none', background: 'none', padding: 0, cursor: 'pointer',
  fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-secondary)',
};
const openBlock = { display: 'flex', flexDirection: 'column' };
const dealList = { margin: '0 0 12px', paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 };
const dealItem = { fontSize: 'var(--text-xs)', lineHeight: 1.5, color: 'var(--text-secondary)' };
