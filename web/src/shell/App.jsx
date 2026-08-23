import React, { Suspense, lazy } from 'react';
import AuthProvider, { useAuth } from './auth/AuthProvider.jsx';
import EntitlementsProvider from './billing/EntitlementsProvider.jsx';
import SignInDoorProvider, { useSignInDoor } from './auth/SignInDoor.jsx';
import { verifyToken } from './auth/AuthClient.js';
import { BrandLanding } from './marketing/BrandLanding.jsx';
import { pendingTransactionId, openCheckout } from './billing/checkout.js';
import { PRODUCTS, activeProduct } from './products.js';

const Showcase = lazy(() => import('../showcase/Showcase.jsx'));
const AuthLanding = lazy(() => import('./auth/AuthLanding.jsx').then((m) => ({ default: m.AuthLanding })));
const OAuthConsent = lazy(() => import('./auth/OAuthConsent.jsx').then((m) => ({ default: m.OAuthConsent })));
const ConnectPage = lazy(() => import('./connect/ConnectPage.jsx').then((m) => ({ default: m.ConnectPage })));
const SettingsPage = lazy(() => import('./settings/SettingsPage.jsx').then((m) => ({ default: m.SettingsPage })));
const importShell = () => import('./chrome/Shell.jsx').then((m) => ({ default: m.Shell }));
const Shell = lazy(importShell);

// Hash prefixes that upgrade in place to a pathname.
const LEGACY_DOORS = [
  ...PRODUCTS.filter((product) => product.shell.status === 'open').map((product) => [product.switchHash, product.shell.room]),
  ['#/settings', '/app/settings'],
  ['#/connect', '/app/connect'],
];

// Hashes a product declares must never be wrapped in room chrome.
function staysOutsideTheShell(hash) {
  return PRODUCTS.some((product) => product.shell.bare?.(hash));
}

function legacyDoorTarget(pathname, hash) {
  if (staysOutsideTheShell(hash)) return null;
  const door = LEGACY_DOORS.find(([prefix]) => hash.startsWith(prefix));
  const target = door ? door[1] : (hash === '#/' || hash === '#' ? '/' : null);
  if (!target) return null;
  if (pathname === target || pathname.startsWith(`${target}/`)) return null;
  return target;
}

function useHashRoute() {
  // The tick re-routes when the hash itself is unchanged.
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

function ownRoute(pathname) {
  if (pathname === '/' || pathname === '/app' || pathname.startsWith('/app/')) return true;
  return PRODUCTS.some((product) => pathname === product.landing.href);
}

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

// A left-click on a same-origin route we answer becomes a pushState; hash-only changes fall through.
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

// mark={false} is bare ground, no wordmark.
function RouteFallback({ mark = true }) {
  const [waited, setWaited] = React.useState(false);
  React.useEffect(() => {
    if (!mark) return undefined;
    const beat = setTimeout(() => setWaited(true), 160);
    return () => clearTimeout(beat);
  }, [mark]);

  if (!mark) {
    return <div aria-hidden="true" style={{ position: 'fixed', inset: 0, background: 'var(--surface-canvas)' }} />;
  }

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

function AppRoutes() {
  const route = useHashRoute();
  const { signIn } = useAuth();
  const openSignInDoor = useSignInDoor();
  useOwnNavigation();

  // A pushState hop does not reset scroll; do it after the commit.
  const landedOn = React.useRef(window.location.pathname);
  React.useEffect(() => {
    if (landedOn.current === window.location.pathname) return;
    landedOn.current = window.location.pathname;
    window.scrollTo(0, 0);
  });

  // The door upgrades during this render; the effect only catches the URL bar up.
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

  // /oauth/authorize redirects here with the PKCE params in the hash; #/auth would drop them.
  if (route.startsWith('#/oauth/authorize')) {
    return <Suspense fallback={<RouteFallback />}><OAuthConsent /></Suspense>;
  }

  if (pathname === '/app' || pathname.startsWith('/app/')) {
    const neutral = pathname.startsWith('/app/settings')
      ? { Component: SettingsPage, props: { inShell: true } }
      : pathname.startsWith('/app/connect')
        ? { Component: ConnectPage, props: { inShell: true } }
        : null;
    return (
      <Suspense fallback={<RouteFallback mark={false} />}>
        <Shell
          location={{ pathname, hash: route, search: window.location.search }}
          neutral={neutral}
        />
      </Suspense>
    );
  }

  if (route === '#/showcase') {
    return <Suspense fallback={<RouteFallback />}><Showcase /></Suspense>;
  }

  // The first product whose route table claims this URL wins.
  const location = { hash: route, pathname: window.location.pathname, search: window.location.search };
  for (const product of PRODUCTS) {
    const match = product.render(location);
    if (match) {
      const { Component, props } = match;
      return <Suspense fallback={<RouteFallback />}><Component {...props} /></Suspense>;
    }
  }

  // /products/<product> is accepted alongside /<product>.
  const landingPath = pathname.startsWith('/products/') ? pathname.slice('/products'.length) : pathname;
  const landing = PRODUCTS.find((p) => landingPath === p.landing.href || landingPath.startsWith(`${p.landing.href}/`));
  if (landing) {
    const { Component } = landing.landing;
    return <Suspense fallback={<RouteFallback />}><Component /></Suspense>;
  }
  return <BrandLanding />;
}

// Resume only once the server has confirmed an account and this tab minted the id.
function ResumeCheckout() {
  const { account } = useAuth();
  React.useEffect(() => {
    if (!account) return;
    const transactionId = pendingTransactionId();
    const url = new URL(window.location.href);
    if (!url.searchParams.has('_ptxn')) return;
    url.searchParams.delete('_ptxn');
    window.history.replaceState({}, '', url.toString());
    if (transactionId) openCheckout(transactionId);
  }, [account]);
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
