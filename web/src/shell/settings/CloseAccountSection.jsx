// The confirmation is typing your own email, which catches the wrong-account case.

import React, { useState } from 'react';
import { Button, Input } from '../../design-system';
import { useAuth } from '../auth/AuthProvider.jsx';
import { PRODUCTS } from '../products.js';
import { closingDeal } from './accountClosure.js';
import { Section, styles } from './Section.jsx';
import { t } from '../i18n/index.js';

const DEAL = closingDeal(PRODUCTS.map((product) => product.label));

export function CloseAccountSection() {
  const { user, closeAccount } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState(null);

  const emailMatches = confirmEmail.trim().toLowerCase() === user.email.toLowerCase();

  const confirmClose = async () => {
    if (!emailMatches || closing) return;
    setClosing(true);
    setCloseError(null);
    try {
      await closeAccount(user.id);
      window.location.hash = '#/';
    } catch {
      setClosing(false);
      setCloseError(t('shell.closeAccount.failed'));
    }
  };

  return (
    <Section title={t('shell.closeAccount.title')}>
      {!expanded ? (
        <button type="button" style={openRow} onClick={() => setExpanded(true)}>{t('shell.closeAccount.close')}</button>
      ) : (
        <div style={openBlock}>
          <ul style={dealList}>
            {DEAL.map((line) => <li key={line} style={dealItem}>{line}</li>)}
          </ul>
          <p style={styles.fieldLabel}>{t('shell.closeAccount.confirmLabel')}</p>
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
              {closing ? t('shell.closeAccount.closing') : t('shell.closeAccount.close')}
            </Button>
            <Button variant="ghost" size="sm" disabled={closing} onClick={() => { setExpanded(false); setConfirmEmail(''); setCloseError(null); }}>
              {t('shell.common.cancel')}
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
