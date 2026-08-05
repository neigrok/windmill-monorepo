// The settings home (X6 §5) — windmill.works/#/settings, the plain account chrome shared
// with /connect, reached from the seat's "Account settings" row. Signed in, it renders its
// sections in order and nothing else — several of which draw nothing at all when the feature
// behind them isn't a thing on this server yet, which is how the page stays short.
// A ghost visitor gets the same calm copy-gate /connect uses — a line and the sign-in door,
// never a wall — because the worst case of auth is the product's normal signed-out state.

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

// The product-owned settings sections, gathered from the registry so this neutral page names no
// product. `main` sections sit in the product zone right after the account identity; `data` sections
// render last, beside the account's own close. A product with none contributes nothing.
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
          </>
        ) : (
          <div style={{ marginTop: 6 }}>
            <p style={gate}>Sign in to view your settings. Everything's still here — your work stays on this device.</p>
            <Button variant="primary" size="sm" onClick={openSignInDoor}>Sign in</Button>
          </div>
        )}

        {/* Outside the sign-in branch on purpose: appearance is a preference of this device, not of
            an account, so it is here whether or not anyone is signed in. */}
        <AppearanceSection />
      </AccountChrome>

    </>
  );
}

export default SettingsPage;

const title = { fontFamily: 'var(--font-display)', fontSize: '19px', fontWeight: 700, lineHeight: 1.25, margin: '4px 0 2px' };
const gate = { fontSize: 'var(--text-xs)', lineHeight: 1.5, color: 'var(--text-secondary)', margin: '0 0 12px' };
