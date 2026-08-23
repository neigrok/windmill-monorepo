// The journal's route table. A position is a URL: #/journal is today, #/journal/<iso> is that day.

import { lazy } from 'react';
import { journalLandingHead } from './marketing/landingHead.js';
import { forgetOpenStores } from './pageStore.js';

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

// `import.meta.env.DEV` is a literal false in a production build, so neither the route nor the fixtures
// reach a shipped bundle.
const EchoLab = import.meta.env && import.meta.env.DEV
  ? lazy(() => import('./echoes/EchoLab.jsx').then((m) => ({ default: m.EchoLab })))
  : null;

function render({ hash }) {
  if (EchoLab && hash.startsWith('#/journal/echoes-lab')) return { Component: EchoLab, props: { hash } };
  if (hash.startsWith('#/journal')) return { Component: JournalApp, props: { hash } };
  return null;
}

// Called by the shell when the signed-in account changes; never for ghost→signed-in, which is the claim.
// Drops in-memory state only: the departing account's pages stay on disk under their own key.
function forgetDevice() {
  forgetOpenStores();
}

export const journalRoutes = {
  id: 'journal',
  label: 'Journal',
  switchHash: '#/journal',
  home,
  landingAfterSignIn,
  render,
  preloadApp: importJournalApp,
  forgetDevice,
  settingsSections: {
    data: [YourJournalSection],
  },
  landing: {
    head: journalLandingHead,
    href: '/journal',
    Component: JournalLanding,
    preload: importJournalLanding,
    tagline: 'Notice what happened',
    summary: 'Free-form daily writing for people who want to understand themselves, not score themselves. One page a day, yesterday above it — and search that finds the feeling, not the word.',
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
