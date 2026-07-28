// The journal product's route table — the same uniform shape roadmap/notes/gym export, so the shell
// composes all products through one loop. A position is a URL (canon §11): #/journal is today,
// #/journal/2026-07-20 is that day in the canvas, #/journal/search, #/journal/year/2026, etc. The
// canvas resolves the exact position off the hash; the heavy view stays lazy so a first paint of a
// neutral surface never downloads it.

import { lazy } from 'react';

const JournalApp = lazy(() => import('./JournalApp.jsx').then((m) => ({ default: m.JournalApp })));

function home() {
  return '#/journal';
}

// Where a fresh sign-in lands when journal is the active product. Journal has no forks and no lobby —
// a signed-in writer goes straight to today's cursor.
function landingAfterSignIn() {
  return home();
}

function render({ hash }, ctx = {}) {
  if (hash.startsWith('#/journal')) {
    return { Component: JournalApp, props: { hash, openSignInSignal: ctx.openSignInSignal } };
  }
  return null;
}

export const journalRoutes = {
  id: 'journal',
  label: 'Journal',
  switchHash: '#/journal',
  home,
  landingAfterSignIn,
  render,
};
