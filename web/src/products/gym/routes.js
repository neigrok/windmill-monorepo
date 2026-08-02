// The gym product's route table — the same uniform shape roadmap and journal export, so the
// shell composes all three through one loop. #/gym is the log, #/gym/session/<id> one session;
// GymApp resolves the exact position off the hash. Pre-open: no HomeCard and no room of its own
// yet — the shell renders its own no-door cell from label + landingHref, /app/gym redirects to
// the landing, and the author dogfoods at #/gym; the flip to 'open' is gym-landing's move.

import { lazy } from 'react';

const GymApp = lazy(() => import('./GymApp.jsx').then((m) => ({ default: m.GymApp })));

// The gym's own landing at /gym. Pre-open it still has to recognise a signed-in visitor on the
// first frame, which is why it is React here and no longer a static page under public/.
const GymLanding = lazy(() => import('./marketing/GymLanding.jsx').then((m) => ({ default: m.GymLanding })));

function home() {
  return '#/gym';
}

// Where a fresh sign-in lands when gym is the active product: the log. Without this the shell
// falls back to PRODUCTS[0] and a lifter signing in from gym lands on the skill tree.
function landingAfterSignIn() {
  return home();
}

function render({ hash }) {
  if (hash.startsWith('#/gym')) return { Component: GymApp, props: { hash } };
  return null;
}

export const gymRoutes = {
  id: 'gym',
  label: 'Gym',
  switchHash: '#/gym',
  home,
  landingAfterSignIn,
  render,
  // The words the brand root's door for the gym is made of, and pre-open they carry their own
  // caveat in the same breath — the brand root reads the state off `shell.status` below.
  landing: {
    href: '/gym',
    Component: GymLanding,
    tagline: 'Keep a training log',
    summary: 'A quiet record of how you’re moving — sets, sessions, the long line of showing up. Built on the same account, when it opens.',
  },
  shell: {
    icon: 'dumbbell',
    room: '/app/gym',
    scope: { theme: 'dark', brand: 'gym' },
    status: 'pre-open',
    landingHref: '/gym',
  },
};
