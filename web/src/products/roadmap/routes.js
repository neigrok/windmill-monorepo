import { lazy } from 'react';
import { PlaceStore } from './persistence/PlaceStore.js';
import { confirmDeviceOwner } from './persistence/LocalTreeRegistry.js';
import { DEMO_TREE_ID } from './demo/demoStage.js';
import { paidPlansOpen } from '../../shell/billing/checkout.js';
import { roadmapLandingHead } from './marketing/landingHead.js';

const importSkillTreeApp = () => import('./index.js').then((m) => ({ default: m.SkillTreeApp }));
const SkillTreeApp = lazy(importSkillTreeApp);
const BrowsePage = lazy(() => import('./browse/BrowsePage.jsx').then((m) => ({ default: m.BrowsePage })));
const HomeCard = lazy(() => import('./HomeCard.jsx').then((m) => ({ default: m.HomeCard })));

const importRoadmapLanding = () => import('./marketing/RoadmapLanding.jsx').then((m) => ({ default: m.RoadmapLanding }));
const RoadmapLanding = lazy(importRoadmapLanding);

const ReminderSection = lazy(() => import('./settings/ReminderSection.jsx').then((m) => ({ default: m.ReminderSection })));
const PlanSection = lazy(() => import('./settings/PlanSection.jsx').then((m) => ({ default: m.PlanSection })));
const TendingSection = lazy(() => import('./settings/TendingSection.jsx').then((m) => ({ default: m.TendingSection })));
const YourDataSection = lazy(() => import('./settings/YourDataSection.jsx').then((m) => ({ default: m.YourDataSection })));

function home() {
  const place = new PlaceStore().load();
  return place?.treeId ? `#/app/${place.treeId}` : '#/app';
}

function landingAfterSignIn(forkedTree) {
  if (forkedTree) return `#/app/${forkedTree}`;
  return home();
}

function appTarget(hash) {
  const path = hash.split('?')[0];
  if (path.startsWith('#/demo')) return { treeId: DEMO_TREE_ID, birth: false, start: false, demo: true };
  if (path.startsWith('#/t/')) return { treeId: path.slice('#/t/'.length) || null, birth: false, start: false, demo: false };
  if (path === '#/app/new') return { treeId: null, birth: true, start: false, demo: false };
  if (path === '#/app/start') return { treeId: null, birth: false, start: true, demo: false };
  if (path.startsWith('#/app/')) return { treeId: path.slice('#/app/'.length) || null, birth: false, start: false, demo: false };
  return { treeId: null, birth: false, start: false, demo: false };
}

function pathTarget(pathname = typeof window === 'undefined' ? '' : window.location.pathname) {
  const match = /^\/t\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let id;
  try { id = decodeURIComponent(match[1]); }  // a malformed %-escape (/t/%) must degrade, not throw through render
  catch { return null; }
  return id ? { treeId: id } : null;
}

// Returns a { Component, props } descriptor, or null to let the next product answer.
function render({ hash, pathname, search }) {
  // The hash wins over the /t/:id path when it names an app destination.
  const pathShare = pathTarget(pathname);
  if (pathShare && !hash.startsWith('#/')) {
    return { Component: SkillTreeApp, props: { treeId: pathShare.treeId, birth: false, start: false, demo: false } };
  }

  if (hash.startsWith('#/browse')) return { Component: BrowsePage, props: {} };

  const isApp = hash.startsWith('#/app') || hash.startsWith('#/t/') || hash.startsWith('#/demo')
    || new URLSearchParams(search).has('view');
  if (!isApp) return null;

  const target = appTarget(hash);
  return { Component: SkillTreeApp, props: { treeId: target.treeId, birth: target.birth, start: target.start, demo: target.demo } };
}

// Wipes everything on this device stamped for an account; anonymous work stays for the claim.
async function forgetDevice({ next }) {
  // Sweep BEFORE confirming the arriving owner, or unstamped work is attributed to them.
  const { forgetDeviceTrees } = await import('./sync/localTrees.js');
  await forgetDeviceTrees();
  confirmDeviceOwner(next ?? null);
  if (typeof window !== 'undefined' && window.location.hash.startsWith('#/app/')) window.location.hash = '#/app';
}

export const roadmapRoutes = {
  id: 'roadmap',
  label: 'Roadmap',
  switchHash: '#/app',
  home,
  landingAfterSignIn,
  render,
  forgetDevice,
  preloadApp: importSkillTreeApp,
  settingsSections: {
    main: paidPlansOpen() ? [ReminderSection, PlanSection, TendingSection] : [ReminderSection, TendingSection],
    data: [YourDataSection],
  },
  landing: {
    head: roadmapLandingHead,
    href: '/roadmap',
    Component: RoadmapLanding,
    preload: importRoadmapLanding,
    tagline: 'Map what you’re learning',
    root: {
      platforms: 'Web',
      // Both scenes arrive in this product's chunk, so their own sheet cannot hold the space they
      // are about to take on the brand root — the shell's does, from the first paint, out of these.
      // Each is a world zoom-fitted to the frame the shell hands it (--rootScene-frame) with the
      // caption standing under it: the 560×370 glimpse at .6607 of the frame, the 600×480 section
      // tree at .8, and a pixel of slack over each so the reserve is never the shorter of the two.
      reserve: {
        band: 'calc(0.6607 * var(--rootScene-frame) + 24px)',
        section: 'calc(0.8 * var(--rootScene-frame) + 31px)',
      },
      band: {
        title: 'Map what you’re learning as a skill tree.',
        sub: 'Real prerequisites, one checked-off node at a time. No account needed to begin.',
      },
      section: {
        title: 'Your learning, drawn as a skill tree.',
        sub: 'Author a path with real prerequisites. Each node unlocks when the ones before it are done, and the tree animates as you grow.',
        trust: 'No account needed. Your first tree lives in the browser.',
        cta: { href: '#/app/start', label: 'Start your tree' },
        proof: [
          { title: 'Real prerequisites', copy: 'A step opens only when the steps before it are done.' },
          { title: 'Begins without sign-up', copy: 'The first tree is yours in the browser. An account keeps it.' },
          { title: 'Share one link', copy: 'Anyone can read it. Forks keep their own progress.' },
        ],
      },
      Glimpse: lazy(() => import('./marketing/RootScenes.jsx').then((m) => ({ default: m.RoadmapGlimpse }))),
      Illustration: lazy(() => import('./marketing/RootScenes.jsx').then((m) => ({ default: m.RoadmapIllustration }))),
    },
  },
  shell: {
    room: '/app/roadmap',
    // The module the boot preloads this room from (scripts/appBoot.js), checked by test/shell-boundaries.
    module: 'src/products/roadmap/index.js',
    scope: { theme: null, brand: 'roadmap' },
    status: 'open',
    landingHref: '/roadmap',
    HomeCard,
  },
};
