// The settings home, in the account chrome shared with /connect. Signed in it is the account's; signed out it opens on the
// browser's own copy, with the product sections that run on it and a way to sign in for the rest. A lapsed session's page,
// signed out over a copy that is still the account's, holds the way to sign in alone.

import React, { Suspense } from 'react';
import { AccountChrome } from '../account/AccountChrome.jsx';
import { useAuth } from '../auth/AuthProvider.jsx';
import { useSignInDoor } from '../auth/SignInDoor.jsx';
import { PRODUCTS } from '../products.js';
import { Button } from '../../design-system';
import { ProfileSection } from './ProfileSection.jsx';
import { PlanSection } from './PlanSection.jsx';
import { AllowanceSection } from './AllowanceSection.jsx';
import { ConnectedToolsSection } from './ConnectedToolsSection.jsx';
import { ApiKeysSection } from './ApiKeysSection.jsx';
import { SessionsSection } from './SessionsSection.jsx';
import { FeedbackSection } from './FeedbackSection.jsx';
import { CloseAccountSection } from './CloseAccountSection.jsx';
import { useSettingsSeat } from './Section.jsx';
import { t } from '../i18n/settings/index.js';

// `main` sits in the product zone after the account identity; `data` renders last, beside the account's own close.
// Over the browser's own copy, the page keeps that order and holds only the sections a product lists as `signedOut`: those
// that run on it.
const sectionsIn = (zone) => PRODUCTS.flatMap((product) => product.settingsSections?.[zone] ?? []);
const PRODUCT_MAIN_SECTIONS = sectionsIn('main');
const PRODUCT_DATA_SECTIONS = sectionsIn('data');
const RUN_SIGNED_OUT = new Set(sectionsIn('signedOut'));
const SIGNED_OUT_SECTIONS = [...PRODUCT_MAIN_SECTIONS, ...PRODUCT_DATA_SECTIONS].filter((Section) => RUN_SIGNED_OUT.has(Section));

function ProductSections({ sections }) {
  return <Suspense fallback={null}>{sections.map((Section, i) => <Section key={i} />)}</Suspense>;
}

export function SettingsPage({ inShell = false }) {
  const { user } = useAuth();
  const seat = useSettingsSeat();
  const openSignInDoor = useSignInDoor();

  return (
    <AccountChrome width={540} bare={inShell}>
      {/* An account's settings, or with none known on this browser the seat menu's word for the page. */}
      <h1 style={title}>{user ? t('shell.settings.title') : t('shell.account.settings')}</h1>

      {seat === 'loading' ? null : seat === 'signed-in' ? (
        <>
          <ProfileSection />
          <PlanSection />
          <AllowanceSection />
          <ProductSections sections={PRODUCT_MAIN_SECTIONS} />
          <ConnectedToolsSection />
          <ApiKeysSection />
          <SessionsSection />
          <FeedbackSection />
          <ProductSections sections={PRODUCT_DATA_SECTIONS} />
          <CloseAccountSection />
        </>
      ) : (
        <>
          <div style={{ marginTop: 14 }}>
            <p style={signInLine}>{t('shell.settings.signedOut')}</p>
            <Button variant="primary" size="sm" onClick={openSignInDoor}>{t('shell.auth.signIn')}</Button>
          </div>
          {seat === 'browsers-own' && <ProductSections sections={SIGNED_OUT_SECTIONS} />}
        </>
      )}
    </AccountChrome>
  );
}

export default SettingsPage;

const title = { fontFamily: 'var(--font-display)', fontSize: '19px', fontWeight: 700, lineHeight: 1.25, margin: '4px 0 2px' };
const signInLine = { fontSize: 'var(--text-xs)', lineHeight: 1.5, color: 'var(--text-secondary)', margin: '0 0 10px' };
