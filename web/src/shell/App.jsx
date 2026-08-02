import React, { Suspense, lazy } from 'react';
import AuthProvider, { useAuth } from './auth/AuthProvider.jsx';
import EntitlementsProvider from './billing/EntitlementsProvider.jsx';
import SignInDoorProvider, { useSignInDoor } from './auth/SignInDoor.jsx';
import { verifyToken } from './auth/AuthClient.js';
import Marketing from './marketing/Marketing.jsx';
import { BrandLanding } from './marketing/BrandLanding.jsx';
import { pendingTransactionId, openCheckout } from './billing/checkout.js';
import { PRODUCTS, activeProduct } from './products.js';

// Marketing is the site root and our one crawlable/indexable URL, so it ships eagerly with
// the entry chunk — the landing paints in a single download (best LCP). Everything else loads
// on demand behind a Suspense fallback: each product's routes (the heavy WebGL tree, the public
// wall) lazy-load themselves, and the signed-in platform surfaces below do too — none of which
// a first-time visitor to the landing ever renders, so their code stays out of the entry chunk.
const Showcase = lazy(() => import('../Showcase.jsx'));
const AuthLanding = lazy(() => import('./auth/AuthLanding.jsx').then((m) => ({ default: m.AuthLanding })));
const OAuthConsent = lazy(() => import('./auth/OAuthConsent.jsx').then((m) => ({ default: m.OAuthConsent })));
const ConnectPage = lazy(() => import('./connect/ConnectPage.jsx').then((m) => ({ default: m.ConnectPage })));
const SettingsPage = lazy(() => import('./settings/SettingsPage.jsx').then((m) => ({ default: m.SettingsPage })));
const Shell = lazy(() => import('./chrome/Shell.jsx').then((m) => ({ default: m.Shell })));

// The app doors — hash URLs from before /app existed, still set by every landing CTA, product
// switcher and account menu. A door upgrades in place (replaceState, no reload) from ANYWHERE
// except its own room: the bare root, a landing, a share page, the /app home grid, even a
// sibling's room (that is how cross-room switching works). Inside its own room the hash is the
// product's private space and never fires — #/app/t_x inside /app/roadmap is tree navigation,
// not a door. "#/" exact is the exit: back to the brand root. Public surfaces are not doors:
// #/demo, #/t/:id, #/browse, #/auth, #/oauth, #/showcase, #/gym (pre-open); a landing's own
// anchors (/roadmap#how) never match because doors start with "#/".
const LEGACY_DOORS = [
  ['#/app', '/app/roadmap'],
  ['#/journal', '/app/journal'],
  ['#/settings', '/app/settings'],
  ['#/connect', '/app/connect'],
];

function legacyDoorTarget(pathname, hash) {
  const door = LEGACY_DOORS.find(([prefix]) => hash.startsWith(prefix));
  const target = door ? door[1] : (hash === '#/' || hash === '#' ? '/' : null);
  if (!target) return null;
  if (pathname === target || pathname.startsWith(`${target}/`)) return null;
  return target;
}

function useHashRoute() {
  // One subscription for both URL axes: hashchange for the legacy hash world, popstate for the
  // shell's pushState room navigation (chrome/Shell.jsx dispatches it after every push). The
  // hash doubles as the render tick — pathname is read live each render, so a popstate with an
  // unchanged hash still re-routes via the tick counter.
  const [, setTick] = React.useState(0);
  const [hash, setHash] = React.useState(() => window.location.hash);
  React.useEffect(() => {
    const onChange = () => { setHash(window.location.hash); setTick((n) => n + 1); };
    window.addEventListener('hashchange', onChange);
    window.addEventListener('popstate', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener('popstate', onChange);
    };
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

// The shell router. Platform routes (product-neutral account surfaces) are answered here; then
// each product's route table gets a chance to claim the URL; the marketing landing is the root
// fallback. The router lives inside AuthProvider so #/auth's success can claim the session.
//
// The magic link lands on #/auth?token=… (token in the fragment); AuthLanding verifies it, signs
// us in, and hands the post-sign-in destination to the ACTIVE product — the roadmap-specific
// "go to your fork" lives there, not here, so the shell stays product-agnostic. An expired link
// sends us back to that product and asks the one door (auth/SignInDoor.jsx) to open.
function AppRoutes() {
  const route = useHashRoute();
  const { signIn } = useAuth();
  const openSignInDoor = useSignInDoor();

  // A legacy door upgrades this very render — the URL bar catches up in the effect, the route
  // decision below never sees the old shape, and nothing reloads or flashes.
  const upgraded = legacyDoorTarget(window.location.pathname, route);
  React.useLayoutEffect(() => {
    if (upgraded) window.history.replaceState({}, '', upgraded + window.location.search + window.location.hash);
  }, [upgraded, route]);
  const pathname = upgraded ?? window.location.pathname;

  if (route.startsWith('#/auth')) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <AuthLanding
          onVerify={verifyToken}
          onSignedIn={(user, forkedTree) => { signIn(user); window.location.hash = activeProduct(route).landingAfterSignIn(forkedTree); }}
          onOpenDoor={() => { window.location.hash = activeProduct(route).switchHash; openSignInDoor(); }}
        />
      </Suspense>
    );
  }

  // The MCP OAuth consent screen — the backend's /oauth/authorize redirects the browser here
  // with the PKCE params in the hash. Kept off #/auth on purpose: that path lands on the app,
  // which would drop the consent params; this route stays put and lets sign-in resolve in place.
  if (route.startsWith('#/oauth/authorize')) {
    return <Suspense fallback={<RouteFallback />}><OAuthConsent /></Suspense>;
  }

  // The apps surface — one shell at /app, rooms inside (chrome/Shell.jsx). The shell resolves
  // product rooms from the registry; the two account surfaces ride in as neutral rooms so the
  // rail is their chrome. Everything below this branch is the public world: landings, share
  // pages, the demo, and the legacy hash doors on non-root paths.
  if (pathname === '/app' || pathname.startsWith('/app/')) {
    const neutral = pathname.startsWith('/app/settings')
      ? { title: 'Settings', Component: SettingsPage, props: { inShell: true } }
      : pathname.startsWith('/app/connect')
        ? { title: 'Connect', Component: ConnectPage, props: { inShell: true } }
        : null;
    return (
      <Suspense fallback={<RouteFallback />}>
        <Shell
          location={{ pathname, hash: route, search: window.location.search }}
          neutral={neutral}
        />
      </Suspense>
    );
  }

  // #/connect and #/settings need no branches here: they are doors (LEGACY_DOORS), so any
  // pathname that can reach this point has already upgraded into the shell's neutral rooms.

  // The design-system showcase — product-neutral, its own stable URL.
  if (route === '#/showcase') {
    return <Suspense fallback={<RouteFallback />}><Showcase /></Suspense>;
  }

  // Compose the products: the first whose route table claims this URL wins. Each returns a
  // { Component, props } descriptor (or null to pass); one Suspense boundary covers whichever
  // answers, and the components are lazy so only the claimed product's chunk downloads.
  const location = { hash: route, pathname: window.location.pathname, search: window.location.search };
  for (const product of PRODUCTS) {
    const match = product.render(location);
    if (match) {
      const { Component, props } = match;
      return <Suspense fallback={<RouteFallback />}><Component {...props} /></Suspense>;
    }
  }

  // Marketing lives at /<product> now: /roadmap is the roadmap landing (the interactive one,
  // kept in the SPA); /journal and /gym are static pages Caddy serves before this ever runs.
  // /products/roadmap is the legacy path — Caddy 301s it, and this match is the belt to that
  // suspender while old tabs and caches drain. The bare root is the product-neutral brand front
  // door. Both ship eagerly (imported at the top), so the indexed root paints in one download.
  if (pathname.startsWith('/roadmap') || pathname.startsWith('/products/roadmap')) {
    return <Suspense fallback={<RouteFallback />}><Marketing /></Suspense>;
  }
  return <BrandLanding />;
}

// Paddle's payment link lands back on our own origin carrying `?_ptxn=<transaction>` — the signal
// to resume that checkout. It can arrive on any route, so this is read at the root rather than
// owned by a route. The parameter is stripped once consumed, so a refresh doesn't reopen it.
function ResumeCheckout() {
  React.useEffect(() => {
    const transactionId = pendingTransactionId();
    if (!transactionId) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('_ptxn');
    window.history.replaceState({}, '', url.toString());
    openCheckout(transactionId);
  }, []);
  return null;
}

export default function App() {
  return (
    <AuthProvider>
      <EntitlementsProvider>
        <SignInDoorProvider>
          <ResumeCheckout />
          <AppRoutes />
        </SignInDoorProvider>
      </EntitlementsProvider>
    </AuthProvider>
  );
}
