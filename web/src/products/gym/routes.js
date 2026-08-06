// The gym product's route table — the same uniform shape roadmap and journal export, so the
// shell composes all three through one loop. #/gym is Today, #/gym/log the log, #/gym/routines the
// routines and #/gym/stats the statistics; one session, one routine, one finished session and the
// past-workout door hang off those (log.js holds the grammar). GymApp resolves the exact position
// off the hash — including #/gym/shared/…, the coach's read-only workout, which is the one position
// here that resolves for a visitor with no account at all.
// Pre-open: no HomeCard and no room of its own
// yet — the shell renders its own no-door cell from label + landingHref, /app/gym redirects to
// the landing, and the author dogfoods at #/gym; the flip to 'open' is gym-landing's move.

import { lazy } from 'react';
import { gymLandingHead } from './marketing/landingHead.js';

const importGymApp = () => import('./GymApp.jsx').then((m) => ({ default: m.GymApp }));
const GymApp = lazy(importGymApp);

// The gym's own landing at /gym. Pre-open it still has to recognise a signed-in visitor on the
// first frame, which is why it is React here and no longer a static page under public/.
const importGymLanding = () => import('./marketing/GymLanding.jsx').then((m) => ({ default: m.GymLanding }));
const GymLanding = lazy(importGymLanding);

// The training log's one account-settings section — registered here so the neutral settings page
// composes it without ever naming the gym (shell/settings/SettingsPage.jsx reads settingsSections
// off the product registry). `data` renders last, beside the account's own close. Lazy, so it keeps
// its own chunk and never weighs on a settings page opened by somebody who has never trained: it
// draws nothing at all until it has read that this account has a log.
const GymDataSection = lazy(() => import('./settings/GymDataSection.jsx').then((m) => ({ default: m.GymDataSection })));

function home() {
  return '#/gym';
}

// Where a fresh sign-in lands when gym is the active product: Today, the same room `home` names.
// Without this the shell falls back to PRODUCTS[0] and a lifter signing in from gym lands on the
// skill tree.
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
  preloadApp: importGymApp,
  settingsSections: {
    data: [GymDataSection],
  },
  // The words the brand root's door for the gym is made of, and pre-open they carry their own
  // caveat in the same breath — the brand root reads the state off `shell.status` below.
  landing: {
    head: gymLandingHead,
    href: '/gym',
    Component: GymLanding,
    preload: importGymLanding,
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
