// The settings home, in the account chrome shared with /connect.

import React, { Suspense } from 'react';
import { AccountChrome } from '../account/AccountChrome.jsx';
import { useAuth } from '../auth/AuthProvider.jsx';
import { useSignInDoor } from '../auth/SignInDoor.jsx';
import { homeHash, PRODUCTS } from '../products.js';
import { Button } from '../../design-system';
import { ProfileSection } from './ProfileSection.jsx';
import { AppearanceSection } from './AppearanceSection.jsx';
import { ConnectedToolsSection } from './ConnectedToolsSection.jsx';
import { ApiKeysSection } from './ApiKeysSection.jsx';
import { SessionsSection } from './SessionsSection.jsx';
import { FeedbackSection } from './FeedbackSection.jsx';
import { CloseAccountSection } from './CloseAccountSection.jsx';

// `main` sits in the product zone after the account identity; `data` renders last, beside the
// account's own close.
const PRODUCT_MAIN_SECTIONS = PRODUCTS.flatMap((product) => product.settingsSections?.main ?? []);
const PRODUCT_DATA_SECTIONS = PRODUCTS.flatMap((product) => product.settingsSections?.data ?? []);

export function SettingsPage({ inShell = false }) {
  const { user, status } = useAuth();
  const signedIn = status === 'signed-in' && Boolean(user);
  const openSignInDoor = useSignInDoor();

  return (
    <>
      <AccountChrome width={540} backHash={homeHash()} bare={inShell}>
        <h1 style={title}>Account settings</h1>

        {status === 'loading' ? null : signedIn ? (
          <>
            <ProfileSection />
            <Suspense fallback={null}>
              {PRODUCT_MAIN_SECTIONS.map((Section, i) => <Section key={i} />)}
            </Suspense>
            <ConnectedToolsSection />
            <ApiKeysSection />
            <SessionsSection />
            <FeedbackSection />
            <Suspense fallback={null}>
              {PRODUCT_DATA_SECTIONS.map((Section, i) => <Section key={i} />)}
            </Suspense>
            <CloseAccountSection />
          </>
        ) : (
          <div style={{ marginTop: 6 }}>
            <p style={gate}>Sign in to view your settings — they belong to an account, and there isn't one signed in here yet.</p>
            <Button variant="primary" size="sm" onClick={openSignInDoor}>Sign in</Button>
          </div>
        )}

        {/* Outside the sign-in branch: appearance is a device preference. */}
        <AppearanceSection />
      </AccountChrome>

    </>
  );
}

export default SettingsPage;

const title = { fontFamily: 'var(--font-display)', fontSize: '19px', fontWeight: 700, lineHeight: 1.25, margin: '4px 0 2px' };
const gate = { fontSize: 'var(--text-xs)', lineHeight: 1.5, color: 'var(--text-secondary)', margin: '0 0 12px' };
