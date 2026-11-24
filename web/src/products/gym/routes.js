// The gym product's route table. GymApp resolves the exact position off the hash; log.js holds the
// hash grammar.

import { lazy } from 'react';
import { gymLandingHead } from './marketing/landingHead.js';
import { sharedLogTokenOf, sharedTokenOf } from './log.js';
import { adoptGymDeviceRows, createGymApi, gymCommandResult, gymDeviceWork, gymLiveHint, signInWork, watchBrowserCopies } from './gymRuntime.js';
import { t } from './i18n/entry/index.js';
import { forgetRetiredCoach } from './coach/retiredCoach.js';

const importGymApp = () => import('./GymApp.jsx').then((m) => ({ default: m.GymApp }));
const GymApp = lazy(importGymApp);

// Every .jsx here must be lazy: a top-level import would stop plain Node from reading the registry.
const RoutinesGhost = lazy(() => import('./RoutinesGhost.jsx').then((m) => ({ default: m.RoutinesGhost })));

const HomeCard = lazy(() => import('./HomeCard.jsx').then((m) => ({ default: m.HomeCard })));

const importGymLanding = () => import('./marketing/GymLanding.jsx').then((m) => ({ default: m.GymLanding }));
const GymLanding = lazy(importGymLanding);

const GymSettingsSection = lazy(() => import('./settings/GymSettingsSection.jsx').then((m) => ({ default: m.GymSettingsSection })));

// Whether the account's replica holds a row of Coach's the sign-out must act on; with none, Coach's module stays unloaded.
// What Coach keeps only in the page leaves with the seat itself (`CoachTurns.leaveSeat`).
function coachKeeps(engine, matches) {
  return Object.keys(engine.device?.activeReplica?.deviceRows?.('gym') ?? {}).some(matches);
}

// Whether the replica a sign-in would bind is the anon one and holds gym's work, a signed-out workout among it; with none,
// the hook before the seat changes reads nothing.
function holdsSignedOutTraining(engine) {
  return engine.getSnapshot().state === 'anon' && engine.anonymousRecords().scopes.includes('self/gym');
}

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
  // As a sign-out begins, Coach ends its running turn and forgets what it kept in the browser (gym Coach on the AI
  // service §5). Before the seat changes, each signed-out workout is saved for adoption; the sign-in question, asked
  // whenever the account holds gym records of its own, counts every kind of gym work the browser holds, the saved
  // workouts and form drafts join the account entry by entry, and from the engine's opening the copies the account took
  // are let go (web-device-parity §3).
  sync: { liveHint: gymLiveHint, onPushResult: gymCommandResult,
    prepare: (engine) => watchBrowserCopies(engine),
    pendingDeviceWork: gymDeviceWork,
    adoptDeviceRows: adoptGymDeviceRows,
    signInWork,
    seatWillChange: (engine) => (holdsSignedOutTraining(engine) ? createGymApi(engine).saveSignedOutWorkouts() : null),
    signOutBegins: (engine) => {
      forgetRetiredCoach();
      return coachKeeps(engine, (key) => key === 'runningTurn') ? import('./coach/coachTurns.js').then((coach) => coach.coachSeatWillChange(engine)) : null;
    },
    // As the sign-out is decided, the rows Coach keeps that its finish takes: the mark, and the pictures no unsent question names.
    signOutForgets: (engine) => coachKeeps(engine, (key) => key === 'runningTurn' || key === 'runningRound' || key.startsWith('picture:'))
      ? import('./coach/coachTurns.js').then((coach) => coach.coachRowsToForget(engine)) : null },
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
