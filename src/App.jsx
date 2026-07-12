import React, { Suspense, lazy } from 'react';
import AuthProvider, { useAuth } from './skilltree/auth/AuthProvider.jsx';
import { AuthLanding } from './skilltree/auth/AuthLanding.jsx';
import { OAuthConsent } from './skilltree/auth/OAuthConsent.jsx';
import { verifyToken } from './skilltree/auth/AuthClient.js';

// Both routes are lazy so the entry chunk is just React + the router: the
// heavy WebGL skill-tree route and the design-system showcase each load
// on demand, and the first paint below shows instantly while they stream in.
const SkillTreeView = lazy(() => import('./skilltree').then((m) => ({ default: m.SkillTreeView })));
const Showcase = lazy(() => import('./Showcase.jsx'));
const Marketing = lazy(() => import('./marketing/Marketing.jsx'));

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

  if (route.startsWith('#/auth')) {
    return (
      <AuthLanding
        onVerify={verifyToken}
        onSignedIn={(user) => { signIn(user); window.location.hash = '#/app'; }}
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

  const isApp = route.startsWith('#/app') || route.startsWith('#/t/')
    || new URLSearchParams(window.location.search).has('view');

  return (
    <Suspense fallback={<RouteFallback />}>
      {route === '#/showcase' ? <Showcase />
        : isApp ? <SkillTreeView openSignInSignal={openSignInSignal} />
        : <Marketing />}
    </Suspense>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
