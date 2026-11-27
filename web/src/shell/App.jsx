import React, { Suspense, lazy } from 'react';
import { BrandLogo } from '../design-system';
import AuthProvider, { useAuth } from './auth/AuthProvider.jsx';
import EntitlementsProvider from './billing/EntitlementsProvider.jsx';
import SignInDoorProvider, { useSignInDoor } from './auth/SignInDoor.jsx';
import { verifyToken } from './auth/AuthClient.js';
import { BrandLanding } from './marketing/BrandLanding.jsx';
import { PRODUCTS, activeProduct } from './products.js';
import { ProductSessions } from './ProductSessions.jsx';
import { PageFrame } from './PageFrame.jsx';
import { navigate, readNavigation, subscribeNavigation, replaceLocation } from './navigation.js';

const Showcase = lazy(() => import('../showcase/Showcase.jsx'));
const AuthLanding = lazy(() => import('./auth/AuthLanding.jsx').then((m) => ({ default: m.AuthLanding })));
const OAuthConsent = lazy(() => import('./auth/OAuthConsent.jsx').then((m) => ({ default: m.OAuthConsent })));
const ConnectPage = lazy(() => import('./connect/ConnectPage.jsx').then((m) => ({ default: m.ConnectPage })));
const SettingsPage = lazy(() => import('./settings/SettingsPage.jsx').then((m) => ({ default: m.SettingsPage })));
const importShell = () => import('./chrome/Shell.jsx').then((m) => ({ default: m.Shell }));
const Shell = lazy(importShell);
const importProductLanding = () => import('./marketing/ProductLanding.jsx');

// Each product's landing: the shell's page, drawn from the words and pictures the product supplies.
const LANDINGS = new Map(PRODUCTS.map((product) => [product.id, lazy(() => Promise.all([importProductLanding(), product.landing.page()])
  .then(([{ ProductLanding }, page]) => ({ default: () => <ProductLanding product={product} page={page} /> })))]));

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

function ownRoute(pathname) {
  if (pathname === '/' || pathname === '/app' || pathname.startsWith('/app/')) return true;
  return PRODUCTS.some((product) => pathname === product.landing.href);
}

function warmRoute(pathname, hash) {
  const landing = PRODUCTS.find((product) => product.landing.href === pathname);
  if (landing) {
    importProductLanding();
    landing.landing.page();
    return;
  }
  const door = LEGACY_DOORS.find(([prefix]) => hash.startsWith(prefix));
  const room = door ? door[1] : (pathname.startsWith('/app') ? pathname : null);
  if (!room) return;
  importShell();
  PRODUCTS.find((product) => room === product.shell.room || room.startsWith(`${product.shell.room}/`))?.preloadApp?.();
}

// Same-origin links retain their predecessor for account-page return navigation.
function useOwnNavigation() {
  React.useEffect(() => {
    const follow = (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target.closest?.('a[href]');
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (!ownRoute(url.pathname) && !(url.pathname === readNavigation().pathname && url.hash.startsWith('#/'))) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search
        && !url.hash.startsWith('#/')) return;
      event.preventDefault();
      navigate(url.href);
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

// mark={false} is bare ground, no logo.
function RouteFallback({ mark = true }) {
  return <PageFrame><RouteFallbackContent mark={mark} /></PageFrame>;
}

function RouteFallbackContent({ mark = true }) {
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
      }}
    >
      <BrandLogo style={{ opacity: waited ? 1 : 0, transition: 'opacity 180ms ease' }} />
    </div>
  );
}

function AppRoutes() {
  const accepted = React.useSyncExternalStore(subscribeNavigation, readNavigation, readNavigation);
  const route = accepted.hash;
  const { signIn } = useAuth();
  const openSignInDoor = useSignInDoor();
  useOwnNavigation();

  // A pushState hop does not reset scroll; do it after the commit.
  const landedOn = React.useRef(accepted.pathname);
  React.useEffect(() => {
    if (landedOn.current === accepted.pathname) return;
    landedOn.current = accepted.pathname;
    window.scrollTo(0, 0);
  });

  // The door upgrades during this render; the effect only catches the URL bar up.
  const upgraded = legacyDoorTarget(accepted.pathname, route);
  React.useLayoutEffect(() => {
    if (upgraded) replaceLocation(upgraded + accepted.search + accepted.hash);
  }, [upgraded, route]);
  const pathname = upgraded ?? accepted.pathname;

  if (route.startsWith('#/auth')) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <PageFrame><AuthLanding
          onVerify={verifyToken}
          onSignedIn={(user, forkedTree) => { signIn(user); window.location.hash = activeProduct(route).landingAfterSignIn(forkedTree); }}
          onOpenDoor={() => { window.location.hash = activeProduct(route).switchHash; openSignInDoor(); }}
        /></PageFrame>
      </Suspense>
    );
  }

  // /oauth/authorize redirects here with the PKCE params in the hash; #/auth would drop them.
  if (route.startsWith('#/oauth/authorize')) {
    return <Suspense fallback={<RouteFallback />}><PageFrame><OAuthConsent /></PageFrame></Suspense>;
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
          location={{ pathname, hash: route, search: accepted.search }}
          acceptedPathname={accepted.pathname}
          neutral={neutral}
        />
      </Suspense>
    );
  }

  if (route === '#/showcase') {
    return <Suspense fallback={<RouteFallback />}><PageFrame><Showcase /></PageFrame></Suspense>;
  }

  // The first product whose route table claims this URL wins.
  const location = accepted;
  for (const product of PRODUCTS) {
    const match = product.render(location);
    if (match) {
      const { Component, props, inRoom } = match;
      if (inRoom) return <Suspense fallback={<RouteFallback mark={false} />}><Shell location={location} roomProduct={product} /></Suspense>;
      return <Suspense fallback={<RouteFallback />}><PageFrame><Component {...props} /></PageFrame></Suspense>;
    }
  }

  // /products/<product> is accepted alongside /<product>.
  const landingPath = pathname.startsWith('/products/') ? pathname.slice('/products'.length) : pathname;
  const landing = PRODUCTS.find((p) => landingPath === p.landing.href || landingPath.startsWith(`${p.landing.href}/`));
  if (landing) {
    const Landing = LANDINGS.get(landing.id);
    return <Suspense fallback={<RouteFallback />}><Landing /></Suspense>;
  }
  return <BrandLanding />;
}

function AppSession() {
  const { dataScope } = useAuth();
  return <Suspense fallback={<RouteFallback />}><ProductSessions products={PRODUCTS} dataScope={dataScope}><AppRoutes /></ProductSessions></Suspense>;
}

export default function App() {
  return (
    <AuthProvider>
      <EntitlementsProvider>
        <SignInDoorProvider>
          <AppSession />
        </SignInDoorProvider>
      </EntitlementsProvider>
    </AuthProvider>
  );
}
