// The roadmap product's route table — the shell composes this beside notes/gym and its own
// platform routes (see shell/App.jsx). Everything the roadmap owns lives here: the #/app
// family, the #/t/:id share (hash and real path), #/demo, ?view, and #/browse. The heavy
// tree view and the public wall stay lazy so a first-paint of the landing never downloads them.

import { lazy } from 'react';
import { PlaceStore } from './persistence/PlaceStore.js';
import { DEMO_TREE_ID } from './demo/demoStage.js';
import { paidPlansOpen } from '../../shell/billing/checkout.js';

const importSkillTreeApp = () => import('./index.js').then((m) => ({ default: m.SkillTreeApp }));
const SkillTreeApp = lazy(importSkillTreeApp);
const BrowsePage = lazy(() => import('./browse/BrowsePage.jsx').then((m) => ({ default: m.BrowsePage })));
const HomeCard = lazy(() => import('./HomeCard.jsx').then((m) => ({ default: m.HomeCard })));

// The roadmap's own landing at /roadmap. It lives here rather than in the shell because a landing
// speaks its product's vocabulary — the shell only knows the pathname to hand it, off the registry.
const importRoadmapLanding = () => import('./marketing/RoadmapLanding.jsx').then((m) => ({ default: m.RoadmapLanding }));
const RoadmapLanding = lazy(importRoadmapLanding);

// The roadmap's account-settings sections — registered here so the neutral settings page composes
// them without ever naming the roadmap (shell/settings/SettingsPage.jsx reads settingsSections off
// the product registry). Lazy, so they keep their own chunks and never weigh on first paint. `main`
// renders in the product zone right after the account identity; `data` (export + close) renders last.
const ReminderSection = lazy(() => import('./settings/ReminderSection.jsx').then((m) => ({ default: m.ReminderSection })));
const PlanSection = lazy(() => import('./settings/PlanSection.jsx').then((m) => ({ default: m.PlanSection })));
const TendingSection = lazy(() => import('./settings/TendingSection.jsx').then((m) => ({ default: m.TendingSection })));
const YourDataSection = lazy(() => import('./settings/YourDataSection.jsx').then((m) => ({ default: m.YourDataSection })));

// Return to work, not a lobby (anon-first-tree F6): home re-opens the last tree this
// device stood in. This is what the shell surfaces as its default "active product home".
function home() {
  const place = new PlaceStore().load();
  return place?.treeId ? `#/app/${place.treeId}` : '#/app';
}

// Where a fresh sign-in lands (F6): a magic link that carried a fork goes to the fork;
// otherwise home. The roadmap-specific `forkedTree` interpretation lives here, not in the
// neutral AuthLanding — the shell just hands whatever verify returned to the active product.
function landingAfterSignIn(forkedTree) {
  if (forkedTree) return `#/app/${forkedTree}`;
  return home();
}

// Which tree the #/app family names: #/app/:id opens it, #/app/new is the birth canvas,
// #/app/start is the quest shelf (F5), #/t/:id is the read-only share, #/demo is the
// playable "Learn to sail" demo (F4 — complete-only, session-local, coached), and bare
// #/app resolves against the registry.
function appTarget(hash) {
  const path = hash.split('?')[0];
  if (path.startsWith('#/demo')) return { treeId: DEMO_TREE_ID, birth: false, start: false, demo: true };
  if (path.startsWith('#/t/')) return { treeId: path.slice('#/t/'.length) || null, birth: false, start: false, demo: false };
  if (path === '#/app/new') return { treeId: null, birth: true, start: false, demo: false };
  if (path === '#/app/start') return { treeId: null, birth: false, start: true, demo: false };
  if (path.startsWith('#/app/')) return { treeId: path.slice('#/app/'.length) || null, birth: false, start: false, demo: false };
  return { treeId: null, birth: false, start: false, demo: false };
}

// Which tree a real /t/:id path names — the indexable, unfurlable twin of the #/t/:id share
// hash. Returns the decoded id (trailing slash ignored), or null for any other path. Pure:
// pass a pathname to test it; the default reads the live location.
export function pathTarget(pathname = typeof window === 'undefined' ? '' : window.location.pathname) {
  const match = /^\/t\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let id;
  try { id = decodeURIComponent(match[1]); }  // a malformed %-escape (/t/%) must degrade, not throw through render
  catch { return null; }
  return id ? { treeId: id } : null;
}

// The route table the shell mounts. Returns a { Component, props } descriptor for any hash/path
// the roadmap owns, or null to let the next product (or the shell's landing) answer. Returning a
// descriptor (not an element) keeps this a plain .js module; the shell instantiates it.
function render({ hash, pathname, search }) {
  // The real share path (/t/:id) renders the same read-only view as the #/t/:id hash — so a
  // link unfurls as itself (the backend rewrites its OG meta) yet still boots the SPA. The
  // hash wins if it names an app destination (e.g. a fork just navigated to #/app/:id).
  const pathShare = pathTarget(pathname);
  if (pathShare && !hash.startsWith('#/')) {
    return { Component: SkillTreeApp, props: { treeId: pathShare.treeId, birth: false, start: false, demo: false } };
  }

  // The in-product public wall (public-gallery §2) — the client-rendered reader of the ranked
  // index /gallery server-renders for strangers. Its own stable URL, entered from the shelf.
  if (hash.startsWith('#/browse')) return { Component: BrowsePage, props: {} };

  const isApp = hash.startsWith('#/app') || hash.startsWith('#/t/') || hash.startsWith('#/demo')
    || new URLSearchParams(search).has('view');
  if (!isApp) return null;

  const target = appTarget(hash);
  return { Component: SkillTreeApp, props: { treeId: target.treeId, birth: target.birth, start: target.start, demo: target.demo } };
}

export const roadmapRoutes = {
  id: 'roadmap',
  label: 'Roadmap',
  switchHash: '#/app',
  home,
  landingAfterSignIn,
  render,
  preloadApp: importSkillTreeApp,
  // Plan only joins the list once there is something to be on — while paid plans are shut it is
  // never mounted, so it costs neither a chunk nor a subscription read (see billing/checkout.js).
  settingsSections: {
    main: paidPlansOpen() ? [ReminderSection, PlanSection, TendingSection] : [ReminderSection, TendingSection],
    data: [YourDataSection],
  },
  // tagline + summary are the words the brand root's door for this product is made of. They live
  // here for the same reason the landing does: the shell must not hold a sentence about roadmaps.
  landing: {
    href: '/roadmap',
    Component: RoadmapLanding,
    preload: importRoadmapLanding,
    tagline: 'Map what you’re learning',
    summary: 'Author a learning path as an RPG skill tree — real prerequisites, ownership gates lifetimes, fundamentals gate frameworks. Grow it one checked-off node at a time.',
  },
  shell: {
    icon: 'route',
    room: '/app/roadmap',
    scope: { theme: null, brand: 'clay' },
    status: 'open',
    landingHref: '/roadmap',
    HomeCard,
  },
};
