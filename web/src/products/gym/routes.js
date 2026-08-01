// The gym product's route table — the same uniform shape roadmap and journal export, so the
// shell composes all three through one loop. #/gym is the log, #/gym/session/<id> one session;
// GymApp resolves the exact position off the hash. Pre-open: no HomeCard and no room of its own
// yet — the shell renders its own no-door cell from label + landingHref, /app/gym redirects to
// the landing, and the author dogfoods at #/gym; the flip to 'open' is gym-landing's move.

import { lazy } from 'react';

const GymApp = lazy(() => import('./GymApp.jsx').then((m) => ({ default: m.GymApp })));

function home() {
  return '#/gym';
}

// Where a fresh sign-in lands when gym is the active product: the log. Without this the shell
// falls back to PRODUCTS[0] and a lifter signing in from gym lands on the skill tree.
function landingAfterSignIn() {
  return home();
}

function render({ hash }, ctx = {}) {
  if (hash.startsWith('#/gym')) {
    return { Component: GymApp, props: { hash, openSignInSignal: ctx.openSignInSignal } };
  }
  return null;
}

export const gymRoutes = {
  id: 'gym',
  label: 'Gym',
  switchHash: '#/gym',
  home,
  landingAfterSignIn,
  render,
  shell: {
    icon: 'dumbbell',
    room: '/app/gym',
    scope: { theme: 'dark', brand: 'gym' },
    status: 'pre-open',
    landingHref: '/gym',
  },
};
