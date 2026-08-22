// The journal product's route table — the same uniform shape roadmap and gym export, so the shell
// composes all products through one loop. A position is a URL (canon §11): #/journal is today,
// #/journal/2026-07-20 is that day in the canvas, #/journal/search, #/journal/year/2026, etc. The
// canvas resolves the exact position off the hash; the heavy view stays lazy so a first paint of a
// neutral surface never downloads it.

import { lazy } from 'react';
import { journalLandingHead } from './marketing/landingHead.js';
import { forgetOpenStores } from './pageStore.js';

const importJournalApp = () => import('./JournalApp.jsx').then((m) => ({ default: m.JournalApp }));
const JournalApp = lazy(importJournalApp);
const HomeCard = lazy(() => import('./HomeCard.jsx').then((m) => ({ default: m.HomeCard })));
// The bars the shell stands on the canvas's ground while JournalApp is still arriving. Lazy like
// everything else on the registry — a top-level .jsx import here would stop plain Node from reading
// the registry at all (shell/marketing/landingHeads.js says why) — and the chrome renders it behind
// its own Suspense boundary, because a fallback may not itself suspend.
const CanvasGhost = lazy(() => import('./CanvasGhost.jsx').then((m) => ({ default: m.CanvasGhost })));

// The journal's own landing at /journal — React now, not a static page, because a visitor who is
// already signed in has to be recognised on the first frame, and no static file can do that.
const importJournalLanding = () => import('./marketing/JournalLanding.jsx').then((m) => ({ default: m.JournalLanding }));
const JournalLanding = lazy(importJournalLanding);

// The journal's account-settings section — registered here so the neutral settings page composes it
// without ever naming the journal (shell/settings/SettingsPage.jsx reads settingsSections off the
// product registry). Lazy, so it keeps its own chunk and never weighs on a first paint of the canvas.
const YourJournalSection = lazy(() => import('./settings/YourJournalSection.jsx').then((m) => ({ default: m.YourJournalSection })));

function home() {
  return '#/journal';
}

// Where a fresh sign-in lands when journal is the active product. Journal has no forks and no lobby —
// a signed-in writer goes straight to today's cursor.
function landingAfterSignIn() {
  return home();
}

// The echo fixtures live behind a dev-only door: a corpus with two and a half years of echoes in it
// is the only way to look at the feature without a backend. `import.meta.env.DEV` is a literal false
// in a production build, so neither the route nor the fixtures reach a shipped bundle.
const EchoLab = import.meta.env && import.meta.env.DEV
  ? lazy(() => import('./echoes/EchoLab.jsx').then((m) => ({ default: m.EchoLab })))
  : null;

function render({ hash }) {
  if (EchoLab && hash.startsWith('#/journal/echoes-lab')) return { Component: EchoLab, props: { hash } };
  if (hash.startsWith('#/journal')) return { Component: JournalApp, props: { hash } };
  return null;
}

// Called by the shell when the signed-in account CHANGES — a sign-out (next: null), or one account
// replacing another. Never called for ghost→signed-in: that is the claim, and the anonymous work on
// this device is meant to follow the person who signs in (pageStore.claimAnonymousDrafts).
//
// What it drops is the departing account's state IN MEMORY: the open canvas, today's draft, the
// queued save, and — because the store falls back to the anonymous scope — what search and the year
// zoom would rebuild from next. What it deliberately does NOT drop is that account's pages on disk.
// They live under their own key (pageCache.js `keyForScope`), no other scope can read them, and
// wiping them would mean signing out on your own laptop threw away the page you wrote on a plane.
// Sign-out ends the session, not the writing.
//
// The shell hands this `{ previous, next }` and the journal needs neither id: which pages are
// readable is decided by the key the device tier is opened under, not by anything remembered here.
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
  // The words the brand root's door for the journal is made of — the product's own, not the shell's.
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
    // The module the boot preloads this room from, so the chunk goes out in the first flight
    // rather than two round trips later (scripts/appBoot.js). Stated beside the room it belongs
    // to, the same way a landing names its own, and checked by test/shell-boundaries.
    module: 'src/products/journal/JournalApp.jsx',
    // No pinned theme: journal follows the app's appearance and maps it onto its own two skins —
    // paper in north light, or dusk with one candle (styles/tokens/palettes.css). Gym still pins
    // its skin; journal does not pin.
    scope: { brand: 'journal' },
    status: 'open',
    landingHref: '/journal',
    HomeCard,
    Ghost: CanvasGhost,
  },
};
