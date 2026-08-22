// The roadmap product's route table — the shell composes this beside journal/gym and its own
// platform routes (see shell/App.jsx). Everything the roadmap owns lives here: the #/app
// family, the #/t/:id share (hash and real path), #/demo, ?view, and #/browse. The heavy
// tree view and the public wall stay lazy so a first-paint of the landing never downloads them.

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

// The roadmap's own landing at /roadmap. It lives here rather than in the shell because a landing
// speaks its product's vocabulary — the shell only knows the pathname to hand it, off the registry.
const importRoadmapLanding = () => import('./marketing/RoadmapLanding.jsx').then((m) => ({ default: m.RoadmapLanding }));
const RoadmapLanding = lazy(importRoadmapLanding);

// The roadmap's account-settings sections — registered here so the neutral settings page composes
// them without ever naming the roadmap (shell/settings/SettingsPage.jsx reads settingsSections off
// the product registry). Lazy, so they keep their own chunks and never weigh on first paint. `main`
// renders in the product zone right after the account identity; `data` — the export, and only the
// export — renders last, above the account's own close, which the shell owns for the whole brand.
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
function pathTarget(pathname = typeof window === 'undefined' ? '' : window.location.pathname) {
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

// The account hand-off (audit WEB-4). The shell calls this when the account holding this device
// changes — a sign-out, or one account replacing another (shell/auth/accountChange.js). The
// roadmap gives up everything on the device that is not anonymous: the device-index rows stamped
// for an account, each one's workspace, progress, legend and ledgers, its lattice blob, and the
// last place. Dropping a signed-in account's local copy costs that account nothing — the server
// holds the tree and hands it back on their next sign-in — so nothing here is a leak to "restore"
// later. Anonymous work stays: it belongs to this device and is meant to follow whoever signs in
// next, which is the claim.
//
// The sweep is the second line, not the first: every device row also carries its owner, so the
// arriving account can already read none of this even when the hook never runs (a crashed tab, a
// killed browser). Loading it lazily keeps the whole sync stack out of the landing's first paint.
async function forgetDevice({ next }) {
  // The sweep runs BEFORE the arriving account is confirmed, and the order is load-bearing:
  // confirming first would attribute anything still unstamped to the person arriving, handing
  // them rows the departing account left. Swept first, those rows are gone instead.
  const { forgetDeviceTrees } = await import('./sync/localTrees.js');
  await forgetDeviceTrees();
  // The shell settled this from an authoritative answer, so it counts as a confirmation.
  confirmDeviceOwner(next ?? null);
  // This tab may still be painting the tree that was just dropped. Bare #/app re-resolves under
  // the arriving account and lands on the shelf when it owns nothing on this device.
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
  // Plan only joins the list once there is something to be on — while paid plans are shut it is
  // never mounted, so it costs neither a chunk nor a subscription read (see billing/checkout.js).
  settingsSections: {
    main: paidPlansOpen() ? [ReminderSection, PlanSection, TendingSection] : [ReminderSection, TendingSection],
    data: [YourDataSection],
  },
  // tagline + summary are the words the brand root's door for this product is made of. They live
  // here for the same reason the landing does: the shell must not hold a sentence about roadmaps.
  landing: {
    head: roadmapLandingHead,
    href: '/roadmap',
    Component: RoadmapLanding,
    preload: importRoadmapLanding,
    tagline: 'Map what you’re learning',
    summary: 'Author a learning path as an RPG skill tree — real prerequisites, ownership gates lifetimes, fundamentals gate frameworks. Grow it one checked-off node at a time.',
  },
  shell: {
    room: '/app/roadmap',
    // The module the boot preloads this room from, so the chunk goes out in the first flight
    // rather than two round trips later (scripts/appBoot.js). Stated beside the room it belongs
    // to, the same way a landing names its own, and checked by test/shell-boundaries.
    module: 'src/products/roadmap/index.js',
    // Its own brand rather than the bare family default: clay is what every surface belonging to
    // no product stands on (the brand root, marketing, the /app home), and it must not move when
    // this room does. Roadmap's day IS the family cream; its night is the embers after it
    // (styles/tokens/palettes.css).
    scope: { theme: null, brand: 'roadmap' },
    status: 'open',
    landingHref: '/roadmap',
    HomeCard,
    // NO `Ghost`, deliberately — this room waits on its ground and nothing else. Two reasons, and
    // either alone would be enough: a dashed node or a stack of bars would promise a layout the
    // radial engine then contradicts on the first frame, and this product already owns a ghost
    // vocabulary — paste/GhostSkeleton.jsx, which means "this is the tree we parsed out of what you
    // pasted". Borrowing that language for "we are still loading" would corrupt the one it has.
  },
};
