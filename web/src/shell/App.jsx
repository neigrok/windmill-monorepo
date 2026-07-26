import React, { Suspense, lazy } from 'react';
import AuthProvider, { useAuth } from './auth/AuthProvider.jsx';
import { verifyToken } from './auth/AuthClient.js';
import Marketing from './marketing/Marketing.jsx';
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

// The shell router. Platform routes (product-neutral account surfaces) are answered here; then
// each product's route table gets a chance to claim the URL; the marketing landing is the root
// fallback. The router lives inside AuthProvider so #/auth's success can claim the session.
//
// The magic link lands on #/auth?token=… (token in the fragment); AuthLanding verifies it, signs
// us in, and hands the post-sign-in destination to the ACTIVE product — the roadmap-specific
// "go to your fork" lives there, not here, so the shell stays product-agnostic. An expired link
// bumps a one-shot signal that opens the sign-in door once the active product is back.
function AppRoutes() {
  const route = useHashRoute();
  const { signIn } = useAuth();
  const [openSignInSignal, setOpenSignInSignal] = React.useState(0);

  if (route.startsWith('#/auth')) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <AuthLanding
          onVerify={verifyToken}
          onSignedIn={(user, forkedTree) => { signIn(user); window.location.hash = activeProduct(route).landingAfterSignIn(forkedTree); }}
          onOpenDoor={() => { setOpenSignInSignal((n) => n + 1); window.location.hash = activeProduct(route).switchHash; }}
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

  // The connect surface (F17) — where a signed-in user points Claude / Cursor / Codex at the
  // hosted MCP server. Account business, its own stable URL, product-neutral chrome.
  if (route.startsWith('#/connect')) {
    return <Suspense fallback={<RouteFallback />}><ConnectPage /></Suspense>;
  }

  // The settings home (X6 §5) — the signed-in account surface. Its own stable URL, plain chrome
  // shared with /connect.
  if (route.startsWith('#/settings')) {
    return <Suspense fallback={<RouteFallback />}><SettingsPage /></Suspense>;
  }

  // The design-system showcase — product-neutral, its own stable URL.
  if (route === '#/showcase') {
    return <Suspense fallback={<RouteFallback />}><Showcase /></Suspense>;
  }

  // Compose the products: the first whose route table claims this URL wins. Each returns a
  // { Component, props } descriptor (or null to pass); one Suspense boundary covers whichever
  // answers, and the components are lazy so only the claimed product's chunk downloads.
  const location = { hash: route, pathname: window.location.pathname, search: window.location.search };
  const ctx = { openSignInSignal };
  for (const product of PRODUCTS) {
    const match = product.render(location, ctx);
    if (match) {
      const { Component, props } = match;
      return <Suspense fallback={<RouteFallback />}><Component {...props} /></Suspense>;
    }
  }

  // Root and every unclaimed hash (e.g. #/welcome) are the marketing landing.
  return <Suspense fallback={<RouteFallback />}><Marketing /></Suspense>;
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
      <ResumeCheckout />
      <AppRoutes />
    </AuthProvider>
  );
}
