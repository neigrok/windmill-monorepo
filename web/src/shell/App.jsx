import React, { Suspense, lazy } from 'react';
import AuthProvider, { useAuth } from './auth/AuthProvider.jsx';
import EntitlementsProvider from './billing/EntitlementsProvider.jsx';
import SignInDoorProvider, { useSignInDoor } from './auth/SignInDoor.jsx';
import { verifyToken } from './auth/AuthClient.js';
import { BrandLanding } from './marketing/BrandLanding.jsx';
import { pendingTransactionId, openCheckout } from './billing/checkout.js';
import { PRODUCTS, activeProduct } from './products.js';

// The brand root is the one view imported eagerly: it answers our most-indexed URL, so it paints
// in a single download (best LCP). Everything else loads on demand behind a Suspense fallback —
// each product's routes (the heavy WebGL tree, the public wall), each product's landing, and the
// signed-in platform surfaces below — none of which a visitor to the root ever renders, so their
// code stays out of the entry chunk.
const Showcase = lazy(() => import('../showcase/Showcase.jsx'));
const AuthLanding = lazy(() => import('./auth/AuthLanding.jsx').then((m) => ({ default: m.AuthLanding })));
const OAuthConsent = lazy(() => import('./auth/OAuthConsent.jsx').then((m) => ({ default: m.OAuthConsent })));
const ConnectPage = lazy(() => import('./connect/ConnectPage.jsx').then((m) => ({ default: m.ConnectPage })));
const SettingsPage = lazy(() => import('./settings/SettingsPage.jsx').then((m) => ({ default: m.SettingsPage })));
// Named rather than inlined, because warming a link to the app calls the same thunk early.
const importShell = () => import('./chrome/Shell.jsx').then((m) => ({ default: m.Shell }));
const Shell = lazy(importShell);

// The app doors — hash URLs from before /app existed, still set by every landing CTA, product
// switcher and account menu. A door upgrades in place (replaceState, no reload) from ANYWHERE
// except its own room: the bare root, a landing, a share page, the /app home grid, even a
// sibling's room (that is how cross-room switching works). Inside its own room the hash is the
// product's private space and never fires — #/app/t_x inside /app/roadmap is tree navigation,
// not a door. "#/" exact is the exit: back to the brand root. Public surfaces are not doors:
// #/demo, #/t/:id, #/browse, #/auth, #/oauth, #/showcase; a landing's own anchors (/roadmap#how)
// never match because doors start with "#/".
//
// The product rows are DERIVED — switchHash and shell.room are already on the registry, and writing
// them out here made the shell restate a product fact it does not own. Only OPEN products get a
// door, which is the rule that used to be an omission: #/gym renders its app but does not upgrade
// into /app/gym, so gym stays outside the room chrome until its status flips. That is now something
// the code says rather than something a reader has to notice is missing.
const LEGACY_DOORS = [
  ...PRODUCTS.filter((product) => product.shell.status === 'open').map((product) => [product.switchHash, product.shell.room]),
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
  //
  // The route change is a transition, which is what keeps a hop smooth: React holds the page the
  // visitor is looking at on screen while the next route's chunk arrives, instead of tearing it
  // down for the Suspense fallback the moment the URL changes.
  const [, setTick] = React.useState(0);
  const [hash, setHash] = React.useState(() => window.location.hash);
  React.useEffect(() => {
    const onChange = () => {
      React.startTransition(() => { setHash(window.location.hash); setTick((n) => n + 1); });
    };
    window.addEventListener('hashchange', onChange);
    window.addEventListener('popstate', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
      window.removeEventListener('popstate', onChange);
    };
  }, []);
  return hash;
}

// Which pathnames this app can answer itself. Everything else on the origin — the static pages,
// /gallery, /t/:id — is a real navigation, because a real server answers it.
function ownRoute(pathname) {
  if (pathname === '/' || pathname === '/app' || pathname.startsWith('/app/')) return true;
  return PRODUCTS.some((product) => pathname === product.landing.href);
}

// Where a link is heading, so its chunk is already arriving by the time the tap lands. Warming is
// pure speculation: it never navigates, and a second call is the module cache answering.
function warmRoute(pathname, hash) {
  const landing = PRODUCTS.find((product) => product.landing.href === pathname);
  if (landing) {
    landing.landing.preload();
    return;
  }
  const door = LEGACY_DOORS.find(([prefix]) => hash.startsWith(prefix));
  const room = door ? door[1] : (pathname.startsWith('/app') ? pathname : null);
  if (!room) return;
  importShell();
  PRODUCTS.find((product) => room === product.shell.room || room.startsWith(`${product.shell.room}/`))?.preloadApp?.();
}

// The four landings are one app, so moving between them should never be a document load: that
// throws away a running page, re-downloads the shell and re-boots React, and the visitor watches
// all of it. This catches the plain left-click on any link we can answer ourselves and turns it
// into a pushState — the anchors keep their real hrefs, so crawlers, ⌘-click and no-JS are
// untouched. Hash-only changes fall through to the browser, which is what makes in-page anchors
// and the legacy #/ doors keep working.
function useOwnNavigation() {
  React.useEffect(() => {
    const follow = (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target.closest?.('a[href]');
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      if (!ownRoute(url.pathname)) return;
      event.preventDefault();
      window.history.pushState({}, '', url.href);
      window.dispatchEvent(new PopStateEvent('popstate'));
    };
    const warm = (event) => {
      const anchor = event.target.closest?.('a[href]');
      if (!anchor) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin === window.location.origin) warmRoute(url.pathname, url.hash);
    };
    document.addEventListener('click', follow);
    document.addEventListener('pointerover', warm);
    document.addEventListener('touchstart', warm, { passive: true });
    return () => {
      document.removeEventListener('click', follow);
      document.removeEventListener('pointerover', warm);
      document.removeEventListener('touchstart', warm);
    };
  }, []);
}

// A wait short enough to feel like nothing should look like nothing. The wordmark waits out a beat
// before it paints, so a chunk that arrives quickly never flashes a screen the eye has to read;
// the canvas underneath is the same cream either way, so the delay shows as stillness, not a gap.
function RouteFallback() {
  const [waited, setWaited] = React.useState(false);
  React.useEffect(() => {
    const beat = setTimeout(() => setWaited(true), 160);
    return () => clearTimeout(beat);
  }, []);

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
      <span style={{ opacity: waited ? 1 : 0, transition: 'opacity 180ms ease' }}>Windmill</span>
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
  useOwnNavigation();

  // A document load starts every page at the top; a pushState hop does not, so it has to be said.
  // After the commit, not during — the visitor should see the page they are leaving hold still,
  // then the new one arrive at its beginning.
  const landedOn = React.useRef(window.location.pathname);
  React.useEffect(() => {
    if (landedOn.current === window.location.pathname) return;
    landedOn.current = window.location.pathname;
    window.scrollTo(0, 0);
  });

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

  // Every landing lives at /<product> and belongs to that product, so the shell names none of
  // them: the registry says which pathname each one answers on. /products/<product> is the shape
  // from before the rename — Caddy 301s it, and dropping the prefix here is the belt to that
  // suspender while old tabs and caches drain. The bare root is the product-neutral front door.
  const landingPath = pathname.startsWith('/products/') ? pathname.slice('/products'.length) : pathname;
  const landing = PRODUCTS.find((p) => landingPath === p.landing.href || landingPath.startsWith(`${p.landing.href}/`));
  if (landing) {
    const { Component } = landing.landing;
    return <Suspense fallback={<RouteFallback />}><Component /></Suspense>;
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
