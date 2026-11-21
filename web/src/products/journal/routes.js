// The journal's route table. A position is a URL: #/journal is today, #/journal/<iso> is that day —
// except on an entry an in-canvas hop stamped, which opens on today (openPosition.js).

import { createElement, lazy } from 'react';
import { journalLandingHead } from './marketing/landingHead.js';
import { migratePages } from './migrate.js';
import { adoptDeviceRows, isWritten, onSyncResult, pagesOf, pendingClaimWork, recoveredDrafts, watchClaims } from './pages.js';
import { talkStore } from './talk/talkStore.js';
import { track } from '../../telemetry/beacon.js';
import { t } from './i18n/entry/index.js';

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

// What signing out takes from this tab: a recording Talk kept, which leaves with the account (forgetDevice below). The
// sign-out question says so and offers it as a download first.
function signOutNotice() {
  const { take } = talkStore.snapshot();
  if (!take) return null;
  return {
    line: t('journal.talk.signOutDiscards'),
    download: { label: t('journal.talk.act.download'), href: take.url, filename: take.filename,
      onDownload: () => track('journal_talk_take', { action: 'download' }) },
  };
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
  signOutNotice,
  // An account change forgets what Talk held for the last account: a recording never crosses accounts.
  forgetDevice: () => talkStore.forget(),
  landing: {
    head: journalLandingHead,
    href: '/journal',
    Component: JournalLanding,
    preload: importJournalLanding,
    tagline: t('journal.product.tagline'),
    // What the brand root shows of the journal: its row among the three tools and its section.
    root: {
      kind: t('journal.root.kind'),
      line: t('journal.root.line'),
      link: { href: home(), label: t('journal.root.link'), to: 'room' },
      title: t('journal.root.title', { break: createElement('br') }),
      paragraph: t('journal.root.paragraph'),
      features: [
        { title: t('journal.root.searchTitle'), text: t('journal.root.searchText') },
        { title: t('journal.root.pageTitle'), text: t('journal.root.pageText') },
        { title: t('journal.root.gradedTitle'), text: t('journal.root.gradedText') },
      ],
      // The picture arrives in this product's chunk, so the shell holds its height from the first paint.
      picture: {
        label: t('journal.root.composed'),
        reserve: { wide: '476px', narrow: '860px' },
        Picture: lazy(() => import('./marketing/RootPicture.jsx').then((m) => ({ default: m.JournalPicture }))),
      },
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
