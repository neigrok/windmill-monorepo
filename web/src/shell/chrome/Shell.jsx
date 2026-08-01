// The /app shell — the common ground behind the landings. One chrome (rail · top bar · room)
// hosts every product as a room; the registry (../products.js) is the only window into them.
// The shell owns theme scope: data-brand/data-theme come from the active room's registry scope
// and are stamped on the shell root, so the rail tints with the room. The shell itself runs
// zero infinite animations — the calm ceiling is the room's budget.

import React, { Suspense, useEffect, useState } from 'react';
import { PRODUCTS } from '../products.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { AccountSeat } from '../auth/AccountSeat.jsx';
import { SignInDialog } from '../auth/SignInDialog.jsx';
import { requestMagicLink } from '../auth/AuthClient.js';
import { ShellHome } from './ShellHome.jsx';
import './chrome.css';

// The chrome's glyphs ride inline (lucide-style, 2px stroke, currentColor) — never a CDN.
// Registry entries name these by their `shell.icon` field.
const ICONS = {
  'layout-grid': <><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></>,
  route: <><circle cx="6" cy="19" r="3" /><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" /><circle cx="18" cy="5" r="3" /></>,
  'notebook-pen': <><path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4" /><path d="M2 6h4" /><path d="M2 10h4" /><path d="M2 14h4" /><path d="M2 18h4" /><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z" /></>,
  dumbbell: <><path d="M14.4 14.4 9.6 9.6" /><path d="M18.657 21.485a2 2 0 1 1-2.829-2.828l-1.767 1.768a2 2 0 1 1-2.829-2.829l6.364-6.364a2 2 0 1 1 2.829 2.829l-1.768 1.767a2 2 0 1 1 2.828 2.829z" /><path d="m21.5 21.5-1.4-1.4" /><path d="M3.9 3.9 2.5 2.5" /><path d="M6.404 12.768a2 2 0 1 1-2.829-2.829l1.768-1.767a2 2 0 1 1-2.828-2.829l2.828-2.828a2 2 0 1 1 2.829 2.828l1.767-1.768a2 2 0 1 1 2.829 2.829z" /></>,
  settings: <><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>,
};

function Icon({ name, size = 19 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name]}
    </svg>
  );
}

// In-shell navigation: swap the pathname without a reload and wake the router. App.jsx's /app
// router listens to popstate; a modified click (new-tab intent) falls through to the real href.
function navigate(href, { replace = false } = {}) {
  if (replace) window.history.replaceState({}, '', href);
  else window.history.pushState({}, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function RoomLink({ href, label, icon, active, quiet = false }) {
  const onClick = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <a
      className={quiet ? 'wm-rail-btn wm-rail-btn--quiet' : 'wm-rail-btn'}
      href={href}
      title={href}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <Icon name={icon} size={quiet ? 18 : 19} />
    </a>
  );
}

// The mobile tab — same door as a rail button, but the label rides under the icon (the
// board's 20px glyph / 11px label column). Room tabs only: settings and the seat live in
// the top bar's mobile cluster, and pre-open products get no tab, same as no rail button.
function TabLink({ href, label, icon, active }) {
  const onClick = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <a className="wm-tab" href={href} aria-current={active ? 'page' : undefined} onClick={onClick}>
      <Icon name={icon} size={20} />
      <span>{label}</span>
    </a>
  );
}

const HOME_SCOPE = { theme: null, brand: 'clay' };

// The decision table: neutral prop → that room verbatim; /app → home; an open product's
// shell.room prefix → its room; a pre-open room → replace-redirect to the landing (no door
// onto nothing); anything else under /app → replace-redirect home. Products without a `shell`
// registry entry don't exist to the chrome.
function resolveRoom(pathname, neutral) {
  if (neutral) return { kind: 'neutral', title: neutral.title, scope: HOME_SCOPE, neutral };
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/app') return { kind: 'home', title: 'Windmill', scope: HOME_SCOPE };
  const product = PRODUCTS.find((p) => p.shell && (path === p.shell.room || path.startsWith(`${p.shell.room}/`)));
  if (product && product.shell.status === 'open') {
    return { kind: 'product', title: product.label, scope: product.shell.scope, product };
  }
  if (product) return { kind: 'redirect', title: product.label, scope: HOME_SCOPE, redirect: { href: product.shell.landingHref, external: true } };
  return { kind: 'home', title: 'Windmill', scope: HOME_SCOPE, redirect: { href: '/app', external: false } };
}

function RoomFallback() {
  return <div className="wm-room-fallback">Windmill</div>;
}

function RoomContent({ room, location, ctx }) {
  if (room.kind === 'redirect') return null;
  if (room.kind === 'home') return <ShellHome />;
  if (room.kind === 'neutral') {
    const { Component, props } = room.neutral;
    return <Suspense fallback={<RoomFallback />}><Component {...(props ?? {})} /></Suspense>;
  }
  const { product } = room;
  const spot = { hash: location.hash, pathname: location.pathname, search: location.search };
  // A bare room URL mounts the product at its own home — synthesized, never written to the URL.
  const match = product.render(spot, ctx) ?? product.render({ ...spot, hash: product.home() }, ctx);
  if (!match) return null;
  const { Component, props } = match;
  return <Suspense fallback={<RoomFallback />}><Component {...props} /></Suspense>;
}

export function Shell({ location, ctx = {}, neutral = null }) {
  const { user, status, signOut } = useAuth();
  const [signInOpen, setSignInOpen] = useState(false);
  const room = resolveRoom(location.pathname, neutral);
  const redirect = room.redirect ?? null;

  useEffect(() => {
    if (!redirect) return;
    if (redirect.external) { window.location.replace(redirect.href); return; }
    navigate(redirect.href, { replace: true });
  }, [redirect?.href, redirect?.external]);

  return (
    <div className="wm-shell" data-brand={room.scope.brand} data-theme={room.scope.theme ?? undefined}>
      <aside className="wm-rail">
        <a className="wm-rail-wordmark" href="/" title="Windmill">W</a>
        <RoomLink href="/app" label="Home" icon="layout-grid" active={room.kind === 'home' && !redirect} />
        {PRODUCTS.filter((p) => p.shell?.status === 'open').map((p) => (
          <RoomLink key={p.id} href={p.shell.room} label={p.label} icon={p.shell.icon} active={room.product?.id === p.id} />
        ))}
        <div className="wm-rail-foot">
          <RoomLink
            href="/app/settings"
            label="Settings"
            icon="settings"
            active={room.kind === 'neutral' && location.pathname.startsWith('/app/settings')}
            quiet
          />
          <AccountSeat
            user={user}
            status={status}
            size={36}
            treeCount={null}
            onSignIn={() => setSignInOpen(true)}
            onSettings={() => navigate('/app/settings')}
            onConnect={() => navigate('/app/connect')}
            onSignOut={signOut}
          />
        </div>
      </aside>
      <div className="wm-body">
        <div className="wm-topbar">
          <div className="wm-topbar-title">{room.title}</div>
          <span className="wm-topbar-url">{location.pathname}</span>
          <div className="wm-topbar-side">
            <div className="wm-topbar-note">One account · one history</div>
            <div className="wm-topbar-seat">
              <AccountSeat
                user={user}
                status={status}
                size={34}
                treeCount={null}
                onSignIn={() => setSignInOpen(true)}
                onSettings={() => navigate('/app/settings')}
                onConnect={() => navigate('/app/connect')}
                onSignOut={signOut}
              />
            </div>
          </div>
        </div>
        <main className="wm-room">
          <RoomContent room={room} location={location} ctx={ctx} />
        </main>
      </div>
      <nav className="wm-tabs" aria-label="Rooms">
        <TabLink href="/app" label="Home" icon="layout-grid" active={room.kind === 'home' && !redirect} />
        {PRODUCTS.filter((p) => p.shell?.status === 'open').map((p) => (
          <TabLink key={p.id} href={p.shell.room} label={p.label} icon={p.shell.icon} active={room.product?.id === p.id} />
        ))}
      </nav>
      <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} onSend={requestMagicLink} />
    </div>
  );
}

export default Shell;
