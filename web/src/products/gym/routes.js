// The gym product's route table. GymApp resolves the exact position off the hash; log.js holds the
// hash grammar.

import { createElement, lazy } from 'react';
import { gymLandingHead } from './marketing/landingHead.js';
import { sharedLogTokenOf, sharedTokenOf } from './log.js';
import { gymLiveHint, gymCommandResult } from './gymRuntime.js';
import { t } from './i18n/entry/index.js';

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
    // What the brand root shows of gym: its row among the three tools and its section.
    root: {
      kind: t('gym.root.kind'),
      line: t('gym.root.line'),
      link: { href: '/gym', label: t('gym.root.link'), to: 'landing' },
      title: t('gym.root.title', { break: createElement('br') }),
      paragraph: t('gym.root.paragraph'),
      features: [
        { title: t('gym.root.remembersTitle'), text: t('gym.root.remembersText') },
        { title: t('gym.root.progressTitle'), text: t('gym.root.progressText') },
        { title: t('gym.root.phoneTitle'), text: t('gym.root.phoneText') },
      ],
      // The picture arrives in this product's chunk, so the shell holds its height from the first paint.
      picture: {
        label: t('gym.root.composed'),
        reserve: { wide: '506px', narrow: '560px' },
        Picture: lazy(() => import('./marketing/RootPicture.jsx').then((m) => ({ default: m.GymPicture }))),
      },
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
