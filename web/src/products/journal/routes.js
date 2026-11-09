// The journal's route table. A position is a URL: #/journal is today, #/journal/<iso> is that day —
// except on an entry an in-canvas hop stamped, which opens on today (openPosition.js).

import { lazy } from 'react';
import { journalLandingHead } from './marketing/landingHead.js';
import { migratePages } from './migrate.js';
import { adoptDeviceRows, isWritten, onSyncResult, pagesOf, pendingClaimWork, recoveredDrafts, watchClaims } from './pages.js';
import { t } from './i18n/index.js';

const importJournalApp = () => import('./JournalApp.jsx').then((m) => ({ default: m.JournalApp }));
const JournalApp = lazy(importJournalApp);
const HomeCard = lazy(() => import('./HomeCard.jsx').then((m) => ({ default: m.HomeCard })));
// Lazy like everything on the registry: a top-level .jsx import would stop plain Node reading it. The
// chrome renders it behind its own Suspense boundary, because a fallback may not itself suspend.
const CanvasGhost = lazy(() => import('./CanvasGhost.jsx').then((m) => ({ default: m.CanvasGhost })));

// React rather than a static page: a visitor already signed in is recognised on the first frame.
const importJournalLanding = () => import('./marketing/JournalLanding.jsx').then((m) => ({ default: m.JournalLanding }));
const JournalLanding = lazy(importJournalLanding);

// Registered here so the neutral settings page composes it without naming the journal.
const YourJournalSection = lazy(() => import('./settings/YourJournalSection.jsx').then((m) => ({ default: m.YourJournalSection })));

function home() {
  return '#/journal';
}

function landingAfterSignIn() {
  return home();
}

function render({ hash }) {
  if (hash.startsWith('#/journal')) return { Component: JournalApp, props: { hash } };
  return null;
}

export const journalRoutes = {
  id: 'journal',
  label: t('journal.product.name'),
  switchHash: '#/journal',
  home,
  landingAfterSignIn,
  render,
  preloadApp: importJournalApp,
  // How the journal rides the browser engine; the shell composes every product's hooks into it.
  sync: {
    prepare: async (engine) => { await migratePages(engine); watchClaims(engine); },
    onPushResult: onSyncResult,
    pendingDeviceWork: pendingClaimWork,
    adoptDeviceRows,
    adoptionAnswer: (engine) => [...pagesOf(engine), ...recoveredDrafts(engine)].some(isWritten) ? null : 'add',
    adoptionCount: (engine) => new Set([...pagesOf(engine), ...recoveredDrafts(engine)].filter(isWritten).map((page) => page.day)).size,
    // The work a sign-in question counts from before sign-in: the journal's pages.
    signedOutWork: {
      type: 'page',
      counted: (count) => t('journal.signedOutWork.counted', { count }),
      many: t('journal.signedOutWork.many'),
    },
  },
  settingsSections: {
    data: [YourJournalSection],
  },
  landing: {
    head: journalLandingHead,
    href: '/journal',
    Component: JournalLanding,
    preload: importJournalLanding,
    tagline: t('journal.product.tagline'),
    root: {
      platforms: t('journal.product.platforms'),
      // A card of prose, so its height steps with where the text wraps rather than scaling with the
      // frame: it settles at these once the words stop rewrapping, and stands taller on a phone.
      // Holding the settled height is strictly better than holding nothing at every width.
      reserve: { band: '170px', section: '322px' },
      band: {
        title: t('journal.product.band.title'),
        sub: t('journal.product.band.sub'),
      },
      section: {
        title: t('journal.product.section.title'),
        sub: t('journal.product.section.sub'),
        trust: t('journal.product.section.trust'),
        cta: { href: '#/journal', label: t('journal.product.section.cta') },
        proof: [
          { title: t('journal.product.proof.pageTitle'), copy: t('journal.product.proof.pageCopy') },
          { title: t('journal.product.proof.searchTitle'), copy: t('journal.product.proof.searchCopy') },
          { title: t('journal.product.proof.privateTitle'), copy: t('journal.product.proof.privateCopy') },
        ],
      },
      Glimpse: lazy(() => import('./marketing/RootScenes.jsx').then((m) => ({ default: m.JournalGlimpse }))),
      Illustration: lazy(() => import('./marketing/RootScenes.jsx').then((m) => ({ default: m.JournalIllustration }))),
    },
  },
  shell: {
    room: '/app/journal',
    // The module the boot preloads this room from (scripts/appBoot.js); checked by test/shell-boundaries.
    module: 'src/products/journal/JournalApp.jsx',
    // No pinned theme: journal follows the app's appearance.
    scope: { brand: 'journal' },
    status: 'open',
    landingHref: '/journal',
    HomeCard,
    Ghost: CanvasGhost,
  },
};
