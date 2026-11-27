import { createElement, lazy } from 'react';
import { invalidateStepDraftSession } from './step/StepDraftSession.js';
import { readNavigation, replaceLocation } from '../../shell/navigation.js';
import { PlaceStore } from './persistence/PlaceStore.js';
import { noteForked } from './persistence/ViewPrefs.js';
import { confirmDeviceOwner } from './persistence/LocalTreeRegistry.js';
import { DEMO_TREE_ID } from './demo/demoStage.js';
import { roadmapLandingHead } from './marketing/landingHead.js';
import { t } from './i18n/entry/index.js';
import { YOUR_ROADMAPS } from './identity/HeldDeletion.js';
import { ROOM_READS_REPLICA } from './replicaRoom.js';

const StepDraftProvider = lazy(() => import('./step/StepDraftProvider.jsx').then((m) => ({ default: m.StepDraftProvider })));
const StepDraftNotice = lazy(() => import('./step/StepDraftProvider.jsx').then((m) => ({ default: m.StepDraftNotice })));
const RoadmapSession = lazy(() => import('./RoadmapSession.jsx').then((m) => ({ default: m.RoadmapSession })));

// Roadmap's part in a sign-in, a sign-out and an account change, loaded when one comes.
const accountChange = () => import('./sync/accountChange.js');

const importSkillTreeApp = () => import('./index.js').then((m) => ({ default: m.SkillTreeApp }));
const SkillTreeApp = lazy(importSkillTreeApp);
const BrowsePage = lazy(() => import('./browse/BrowsePage.jsx').then((m) => ({ default: m.BrowsePage })));
const YourRoadmaps = lazy(() => import('./identity/YourRoadmaps.jsx').then((m) => ({ default: m.YourRoadmaps })));
const HomeCard = lazy(() => import('./HomeCard.jsx').then((m) => ({ default: m.HomeCard })));

const ReminderSection = lazy(() => import('./settings/ReminderSection.jsx').then((m) => ({ default: m.ReminderSection })));
const TendingSection = lazy(() => import('./settings/TendingSection.jsx').then((m) => ({ default: m.TendingSection })));
const YourDataSection = lazy(() => import('./settings/YourDataSection.jsx').then((m) => ({ default: m.YourDataSection })));

function home() {
  const place = new PlaceStore().load();
  return place?.treeId ? `#/app/${place.treeId}` : '#/app';
}

function landingAfterSignIn(forkedTree) {
  if (!forkedTree) return home();
  noteForked();
  return `#/app/${forkedTree}`;
}

export function appTarget(hash) {
  const path = hash.split('?')[0];
  if (path.startsWith('#/demo')) return { treeId: DEMO_TREE_ID, birth: false, start: false, demo: true };
  if (path.startsWith('#/t/')) return { treeId: path.slice('#/t/'.length) || null, birth: false, start: false, demo: false };
  if (path === '#/app/new') return { treeId: null, birth: true, start: false, demo: false };
  if (path === '#/app/start') return { treeId: null, birth: false, start: true, demo: false };
  if (path.startsWith('#/app/')) return { treeId: path.slice('#/app/'.length) || null, birth: false, start: false, demo: false };
  return { treeId: null, birth: false, start: false, demo: false };
}

export function pathTarget(pathname = typeof window === 'undefined' ? '' : window.location.pathname) {
  const match = /^\/t\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let id;
  try { id = decodeURIComponent(match[1]); }  // a malformed %-escape (/t/%) must degrade, not throw through render
  catch { return null; }
  return id ? { treeId: id } : null;
}

// Returns a { Component, props, inRoom } descriptor, or null to let the next product answer. `inRoom` mounts a roadmap,
// a share link or the demo inside the room's chrome on its own URL: the Shell is their way home and their Sign in.
function render({ hash, pathname, search }) {
  // The hash wins over the /t/:id path when it names an app destination.
  const pathShare = pathTarget(pathname);
  if (pathShare && !hash.startsWith('#/')) {
    return { Component: SkillTreeApp, props: { treeId: pathShare.treeId, birth: false, start: false, demo: false, replica: ROOM_READS_REPLICA }, inRoom: true };
  }

  if (hash.startsWith('#/browse')) return { Component: BrowsePage, props: {} };
  // The person's roadmaps, where a deletion of the open one lands: only where the room reads the device's copy.
  if (ROOM_READS_REPLICA && hash.split('?')[0] === YOUR_ROADMAPS) return { Component: YourRoadmaps, props: {}, inRoom: true };

  const isApp = hash.startsWith('#/app') || hash.startsWith('#/t/') || hash.startsWith('#/demo')
    || new URLSearchParams(search).has('view');
  if (!isApp) return null;

  const target = appTarget(hash);
  return { Component: SkillTreeApp, props: { treeId: target.treeId, birth: target.birth, start: target.start, demo: target.demo, replica: ROOM_READS_REPLICA }, inRoom: true };
}

// Explicit sign-out, account replacement and account closure take what the browser kept of every roadmap but the
// anonymous ones, Keep or Discard. Roadmap's own sync also wipes stamped work; on the device's copy the engine's Keep or
// Discard decides what is unsent, a Discard takes the old stores its question named, and the rest of the old stores are
// the carry-over's to empty once carried (INV-4). A session lapse never calls this hook.
async function forgetDevice({ previous = null, next, navigation }) {
  // Sweep BEFORE confirming the arriving owner, or unstamped work is attributed to them.
  if (ROOM_READS_REPLICA) await (await accountChange()).forgetReplicaRoom({ previous });
  else await (await import('./sync/localTrees.js')).forgetDeviceTrees();
  confirmDeviceOwner(next ?? null);
  if (typeof window === 'undefined' || !readNavigation().hash.startsWith('#/app/')) return;
  if (navigation) navigation.navigate('#/app', { replace: true });
  else replaceLocation('#/app');
}

export const roadmapRoutes = {
  id: 'roadmap',
  // Where the room reads the device's copy (replicaRoom.js), the session keeps the one list of what cannot land beside the
  // step draft, and roadmap words the shell's sign-in and sign-out questions; elsewhere the session is the step draft's alone.
  session: { Provider: ROOM_READS_REPLICA ? RoadmapSession : StepDraftProvider, Notice: StepDraftNotice, invalidateAccount: invalidateStepDraftSession },
  sync: ROOM_READS_REPLICA ? {
    adoptionAnswer: async (engine, due) => (await accountChange()).adoptionAnswer(engine, due),
    signInWords: async (engine, due) => (await accountChange()).signInWords(engine, due),
    signOutWords: async (engine, question) => (await accountChange()).signOutWords(engine, question),
  } : undefined,
  label: t('roadmap.product.name'),
  switchHash: '#/app',
  home,
  landingAfterSignIn,
  render,
  forgetDevice,
  preloadApp: importSkillTreeApp,
  // The reminder and the tending are the account's; the export reads the device's trees, so signed out shows it too.
  settingsSections: {
    main: [ReminderSection, TendingSection],
    data: [YourDataSection],
    signedOut: [YourDataSection],
  },
  landing: {
    head: roadmapLandingHead,
    href: '/roadmap',
    page: () => import('./marketing/landingPage.js').then((m) => m.roadmapLandingPage),
    tagline: t('roadmap.product.tagline'),
    // What the brand root shows of roadmap: its row among the three tools and its section.
    root: {
      kind: t('roadmap.root.kind'),
      line: t('roadmap.root.line'),
      link: { href: '#/app/start', label: t('roadmap.root.link'), to: 'room' },
      title: t('roadmap.root.title', { break: createElement('br') }),
      paragraph: t('roadmap.root.paragraph'),
      features: [
        { title: t('roadmap.root.unlockTitle'), text: t('roadmap.root.unlockText') },
        { title: t('roadmap.root.noAccountTitle'), text: t('roadmap.root.noAccountText') },
        { title: t('roadmap.root.shareTitle'), text: t('roadmap.root.shareText') },
      ],
      // Each stage is the picture's own drawn size; the shell holds the frame to one before the picture's chunk arrives.
      picture: {
        label: t('roadmap.scene.composed'),
        stages: [{ name: 'narrow', width: 356, height: 364 }, { name: 'column', width: 720, height: 584 }, { name: 'row', width: 1080, height: 500 }],
        Picture: lazy(() => import('./marketing/RootPicture.jsx').then((m) => ({ default: m.RoadmapPicture }))),
      },
    },
  },
  shell: {
    room: '/app/roadmap',
    // The module the boot preloads this room from (scripts/appBoot.js), checked by test/shell-boundaries.
    module: 'src/products/roadmap/index.js',
    scope: { theme: null, brand: 'roadmap' },
    sharedShell: true,
    status: 'open',
    landingHref: '/roadmap',
    HomeCard,
  },
};
