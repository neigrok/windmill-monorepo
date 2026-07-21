// The settings home (X6 §5) — windmill.works/#/settings, the plain account chrome shared
// with /connect, reached from the seat's "Account settings" row. Signed in, it renders the
// four sections and nothing else: Profile, Connected tools, Sessions & devices, Your data.
// A ghost visitor gets the same calm copy-gate /connect uses — a line and the sign-in door,
// never a wall — because the worst case of auth is the product's normal signed-out state.

import React, { useState } from 'react';
import { AccountChrome } from '../account/AccountChrome.jsx';
import { useAuth } from '../auth/AuthProvider.jsx';
import { requestMagicLink } from '../auth/AuthClient.js';
import { SignInDialog } from '../auth/SignInDialog.jsx';
import { Button } from '../../components';
import { ProfileSection } from './ProfileSection.jsx';
import { PlanSection } from './PlanSection.jsx';
import { TendingSection } from './TendingSection.jsx';
import { ConnectedToolsSection } from './ConnectedToolsSection.jsx';
import { ApiKeysSection } from './ApiKeysSection.jsx';
import { SessionsSection } from './SessionsSection.jsx';
import { FeedbackSection } from './FeedbackSection.jsx';
import { YourDataSection } from './YourDataSection.jsx';

export function SettingsPage() {
  const { user, status } = useAuth();
  const signedIn = status === 'signed-in' && Boolean(user);
  const [signInOpen, setSignInOpen] = useState(false);

  return (
    <>
      <AccountChrome width={540}>
        <h1 style={title}>Account settings</h1>

        {status === 'loading' ? null : signedIn ? (
          <>
            <ProfileSection />
            <PlanSection />
            <TendingSection />
            <ConnectedToolsSection />
            <ApiKeysSection />
            <SessionsSection />
            <FeedbackSection />
            <YourDataSection />
          </>
        ) : (
          <div style={{ marginTop: 6 }}>
            <p style={gate}>Sign in to view your settings. Everything's still here — your trees live on this device.</p>
            <Button variant="primary" size="sm" onClick={() => setSignInOpen(true)}>Sign in</Button>
          </div>
        )}
      </AccountChrome>

      <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} onSend={requestMagicLink} />
    </>
  );
}

export default SettingsPage;

const title = { fontFamily: 'var(--font-display)', fontSize: '19px', fontWeight: 700, lineHeight: 1.25, margin: '4px 0 2px' };
const gate = { fontSize: 'var(--text-xs)', lineHeight: 1.5, color: 'var(--text-secondary)', margin: '0 0 12px' };
