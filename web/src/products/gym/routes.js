// The gym product's route table. GymApp resolves the exact position off the hash; log.js holds the
// hash grammar.

import { lazy } from 'react';
import { gymLandingHead } from './marketing/landingHead.js';
import { sharedLogTokenOf, sharedTokenOf } from './log.js';
import { gymLiveHint, gymCommandResult } from './gymRuntime.js';
import { t } from './i18n/index.js';

const importGymApp = () => import('./GymApp.jsx').then((m) => ({ default: m.GymApp }));
const GymApp = lazy(importGymApp);

// Every .jsx here must be lazy: a top-level import would stop plain Node from reading the registry.
const RoutinesGhost = lazy(() => import('./RoutinesGhost.jsx').then((m) => ({ default: m.RoutinesGhost })));

const HomeCard = lazy(() => import('./HomeCard.jsx').then((m) => ({ default: m.HomeCard })));

const importGymLanding = () => import('./marketing/GymLanding.jsx').then((m) => ({ default: m.GymLanding }));
const GymLanding = lazy(importGymLanding);

const GymSettingsSection = lazy(() => import('./settings/GymSettingsSection.jsx').then((m) => ({ default: m.GymSettingsSection })));

function home() {
  return '#/gym';
}

// Where a fresh sign-in lands when gym is the active product; without it the shell falls to PRODUCTS[0].
function landingAfterSignIn() {
  return home();
}

// Read off the pathname the caller hands in: `window.location.pathname` read from inside the app can
// still be the pre-upgrade one.
function inShellRoom(pathname) {
  return pathname === '/app' || (pathname ?? '').startsWith('/app/');
}

function render({ hash, pathname }) {
  if (hash.startsWith('#/gym')) return { Component: GymApp, props: { hash, inShell: inShellRoom(pathname) } };
  return null;
}

export const gymRoutes = {
  id: 'gym',
  label: t('gym.product.name'),
  switchHash: '#/gym',
  home,
  landingAfterSignIn,
  render,
  preloadApp: importGymApp,
  // How the gym rides the browser engine; the shell composes every product's hooks into it.
  sync: { liveHint: gymLiveHint, onPushResult: gymCommandResult },
  // `main`: the product zone, with gym's own dials and its Notes door — not `data`, which sits
  // beside the account's close.
  settingsSections: {
    main: [GymSettingsSection],
  },
  landing: {
    head: gymLandingHead,
    href: '/gym',
    Component: GymLanding,
    preload: importGymLanding,
    tagline: t('gym.product.tagline'),
    // The words and the two still scenes the brand root composes gym's band and section from.
    root: {
      platforms: t('gym.product.platforms'),
      // Cards of prose, so the height steps with where the text wraps rather than scaling with the
      // frame: these are where it settles once the logger and the proposal sit side by side, and
      // the pair stands taller stacked. Holding the settled height beats holding nothing.
      reserve: { band: '220px', section: '412px' },
      band: {
        title: t('gym.product.band.title'),
        sub: t('gym.product.band.sub'),
      },
      section: {
        title: t('gym.product.section.title'),
        sub: t('gym.product.section.sub'),
        trust: t('gym.product.section.trust'),
        cta: { href: home(), label: t('gym.product.section.cta') },
        proof: [
          { title: t('gym.product.proof.tapsTitle'), copy: t('gym.product.proof.tapsCopy') },
          { title: t('gym.product.proof.remembersTitle'), copy: t('gym.product.proof.remembersCopy') },
          { title: t('gym.product.proof.toolsTitle'), copy: t('gym.product.proof.toolsCopy') },
        ],
      },
      Glimpse: lazy(() => import('./marketing/RootScenes.jsx').then((m) => ({ default: m.GymGlimpse }))),
      Illustration: lazy(() => import('./marketing/RootScenes.jsx').then((m) => ({ default: m.GymIllustration }))),
    },
  },
  shell: {
    room: '/app/gym',
    // The module the boot preloads this room from (scripts/appBoot.js); checked by test/shell-boundaries.
    module: 'src/products/gym/GymApp.jsx',
    scope: { brand: 'gym' },
    // A shared workout's link must never be upgraded into the room: whoever opens it may have no
    // account, so the app's rail and a Sign in seat may not be drawn around it.
    bare: (hash) => sharedTokenOf(hash) != null || sharedLogTokenOf(hash) != null,
    // Every surface derives gym's state from this word; nothing outside this line spells it by hand.
    status: 'open',
    landingHref: '/gym',
    HomeCard,
    Ghost: RoutinesGhost,
  },
};
