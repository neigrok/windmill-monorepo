// The journal product's route table — the same uniform shape roadmap/notes/gym export, so the shell
// composes all products through one loop. A position is a URL (canon §11): #/journal is today,
// #/journal/2026-07-20 is that day in the canvas, #/journal/search, #/journal/year/2026, etc. The
// canvas resolves the exact position off the hash; the heavy view stays lazy so a first paint of a
// neutral surface never downloads it.

import { lazy } from 'react';

const importJournalApp = () => import('./JournalApp.jsx').then((m) => ({ default: m.JournalApp }));
const JournalApp = lazy(importJournalApp);
const HomeCard = lazy(() => import('./HomeCard.jsx').then((m) => ({ default: m.HomeCard })));

// The journal's own landing at /journal — React now, not a static page, because a visitor who is
// already signed in has to be recognised on the first frame, and no static file can do that.
const importJournalLanding = () => import('./marketing/JournalLanding.jsx').then((m) => ({ default: m.JournalLanding }));
const JournalLanding = lazy(importJournalLanding);

function home() {
  return '#/journal';
}

// Where a fresh sign-in lands when journal is the active product. Journal has no forks and no lobby —
// a signed-in writer goes straight to today's cursor.
function landingAfterSignIn() {
  return home();
}

function render({ hash }) {
  if (hash.startsWith('#/journal')) return { Component: JournalApp, props: { hash } };
  return null;
}

export const journalRoutes = {
  id: 'journal',
  label: 'Journal',
  switchHash: '#/journal',
  home,
  landingAfterSignIn,
  render,
  preloadApp: importJournalApp,
  // The words the brand root's door for the journal is made of — the product's own, not the shell's.
  landing: {
    href: '/journal',
    Component: JournalLanding,
    preload: importJournalLanding,
    tagline: 'Notice what happened',
    summary: 'Free-form daily writing for people who want to understand themselves, not score themselves. One page a day, yesterday above it — and search that finds the feeling, not the word.',
  },
  shell: {
    icon: 'notebook-pen',
    room: '/app/journal',
    scope: { theme: 'dark', brand: 'journal' },
    status: 'open',
    landingHref: '/journal',
    HomeCard,
  },
};
