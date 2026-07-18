import React, { Suspense, lazy } from 'react';
import AuthProvider, { useAuth } from './skilltree/auth/AuthProvider.jsx';
import { AuthLanding } from './skilltree/auth/AuthLanding.jsx';
import { OAuthConsent } from './skilltree/auth/OAuthConsent.jsx';
import { ConnectPage } from './skilltree/connect/ConnectPage.jsx';
import { SettingsPage } from './skilltree/settings/SettingsPage.jsx';
import { verifyToken } from './skilltree/auth/AuthClient.js';
import { PlaceStore } from './skilltree/persistence/PlaceStore.js';
import { DEMO_TREE_ID } from './skilltree/demo/demoStage.js';
import Marketing from './marketing/Marketing.jsx';

// Marketing is the site root and our one crawlable/indexable URL, so it ships
// eagerly with the entry chunk — the landing paints in a single download (best
// LCP) instead of paying a lazy round-trip. The heavy WebGL skill-tree route and
// the design-system showcase stay lazy: they load on demand while the fallback shows.
const SkillTreeApp = lazy(() => import('./skilltree').then((m) => ({ default: m.SkillTreeApp })));
const Showcase = lazy(() => import('./Showcase.jsx'));

function useHashRoute() {
  const [hash, setHash] = React.useState(() => window.location.hash);
  React.useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

function RouteFallback() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--surface-canvas)',
        color: 'var(--text-tertiary)',
        fontFamily: 'var(--font-display)',
        fontWeight: 800,
        fontSize: 'var(--text-xl)',
        letterSpacing: 'var(--tracking-wide)',
      }}
    >
      Windmill
    </div>
  );
}

// The router lives inside AuthProvider so #/auth's success can claim the session
// through useAuth. The magic link lands on #/auth?token=… (token in the fragment);
// AuthLanding verifies it, signs us in, and drops us into the app at #/app. An expired
// link bumps a one-shot signal that opens the sign-in door once the app is back.
//
// The marketing landing is the site root. The app (editor + read-only share) lives at
// #/app, the #/t/… share hash, or any ?view URL; #/showcase is the design system;
// everything else — root and the #/welcome alias — is the landing.
function AppRoutes() {
  const route = useHashRoute();
  const { signIn } = useAuth();
  const [openSignInSignal, setOpenSignInSignal] = React.useState(0);

  // The real share path (/t/:id) renders the same read-only view as the #/t/:id hash — so a
  // link unfurls as itself (the backend rewrites its OG meta) yet still boots the SPA. The
  // hash wins if it names an app destination (e.g. a fork just navigated to #/app/:id),
  // which also clears the pathname, so the two never both claim the render.
  const pathShare = pathTarget();
  if (pathShare && !route.startsWith('#/')) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <SkillTreeApp treeId={pathShare.treeId} birth={false} start={false} demo={false} openSignInSignal={openSignInSignal} />
      </Suspense>
    );
  }

  if (route.startsWith('#/auth')) {
    return (
      <AuthLanding
        onVerify={verifyToken}
        onSignedIn={(user, forkedTree) => { signIn(user); window.location.hash = landingHash(forkedTree); }}
        onOpenDoor={() => { setOpenSignInSignal((n) => n + 1); window.location.hash = '#/app'; }}
      />
    );
  }

  // The MCP OAuth consent screen — the backend's /oauth/authorize redirects the browser
  // here with the PKCE params in the hash. Kept off #/auth on purpose: that path lands on
  // #/app, which would drop the consent params; this route stays put and lets sign-in
  // resolve in place (AuthProvider flips the tab), preserving the URL for the decision.
  if (route.startsWith('#/oauth/authorize')) {
    return <OAuthConsent />;
  }

  // The connect surface (F17) — where a signed-in user points Claude / Cursor / Codex at the
  // hosted MCP server. Account business, its own stable URL; the tree canvas never learns of MCP.
  if (route.startsWith('#/connect')) {
    return <ConnectPage />;
  }

  // The settings home (X6 §5) — the signed-in account surface: profile, connected tools,
  // sessions, and data. Its own stable URL, plain chrome shared with /connect; the tree
  // canvas never learns of it.
  if (route.startsWith('#/settings')) {
    return <SettingsPage />;
  }

  const isApp = route.startsWith('#/app') || route.startsWith('#/t/') || route.startsWith('#/demo')
    || new URLSearchParams(window.location.search).has('view');

  const target = appTarget(route);

  return (
    <Suspense fallback={<RouteFallback />}>
      {route === '#/showcase' ? <Showcase />
        : isApp ? <SkillTreeApp treeId={target.treeId} birth={target.birth} start={target.start} demo={target.demo} openSignInSignal={openSignInSignal} />
        : <Marketing />}
    </Suspense>
  );
}

// The magic-link landing returns to work, not to a lobby (anon-first-tree F6): a fork
// goes to the fork; otherwise the last place this device stood re-opens — same tree,
// zoom and selection restored by the view. Bare #/app remains the no-history fallback.
function landingHash(forkedTree) {
  if (forkedTree) return `#/app/${forkedTree}`;
  const place = new PlaceStore().load();
  return place?.treeId ? `#/app/${place.treeId}` : '#/app';
}

// Which tree the #/app family names: #/app/:id opens it, #/app/new is the birth canvas,
// #/app/start is the quest shelf (F5), #/t/:id is the read-only share, #/demo is the
// playable "Learn to sail" demo (F4 — complete-only, session-local, coached), and bare
// #/app resolves against the registry.
function appTarget(route) {
  const hash = route.split('?')[0];
  if (hash.startsWith('#/demo')) return { treeId: DEMO_TREE_ID, birth: false, start: false, demo: true };
  if (hash.startsWith('#/t/')) return { treeId: hash.slice('#/t/'.length) || null, birth: false, start: false, demo: false };
  if (hash === '#/app/new') return { treeId: null, birth: true, start: false, demo: false };
  if (hash === '#/app/start') return { treeId: null, birth: false, start: true, demo: false };
  if (hash.startsWith('#/app/')) return { treeId: hash.slice('#/app/'.length) || null, birth: false, start: false, demo: false };
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

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
