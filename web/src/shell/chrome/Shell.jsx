// The /app shell: a room switcher, the account seat, and the active room. data-brand and
// data-theme are stamped together — palettes.css keys a room's ground on the pair.

import React, { Suspense, useEffect, useLayoutEffect } from 'react';
import { PRODUCTS } from '../products.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { AccountSeat } from '../auth/AccountSeat.jsx';
import { useSignInDoor, useSignInDoorHost } from '../auth/SignInDoor.jsx';
import { useAppearance } from '../useAppearance.js';
import { ShellHome } from './ShellHome.jsx';
import './chrome.css';

function navigate(href, { replace = false } = {}) {
  if (replace) window.history.replaceState({}, '', href);
  else window.history.pushState({}, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function RoomLink({ href, label, active }) {
  const onClick = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <a className="wm-switch-btn" href={href} title={href} aria-current={active ? 'page' : undefined} onClick={onClick}>
      {label}
    </a>
  );
}

const HOME_SCOPE = { theme: null, brand: 'clay' };

function resolveRoom(pathname, neutral) {
  if (neutral) return { kind: 'neutral', scope: HOME_SCOPE, neutral };
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/app') return { kind: 'home', scope: HOME_SCOPE };
  const product = PRODUCTS.find((p) => p.shell && (path === p.shell.room || path.startsWith(`${p.shell.room}/`)));
  if (product && product.shell.status === 'open') {
    return { kind: 'product', scope: product.shell.scope, product };
  }
  if (product) return { kind: 'redirect', scope: HOME_SCOPE, redirect: { href: product.shell.landingHref, external: true } };
  return { kind: 'home', scope: HOME_SCOPE, redirect: { href: '/app', external: false } };
}

// A fallback may not itself suspend and the Ghost is a lazy handle, so it gets its own boundary.
function RoomFallback({ Ghost = null }) {
  const ground = <div className="wm-room-fallback" aria-hidden="true" />;
  if (!Ghost) return ground;
  return <Suspense fallback={ground}><Ghost /></Suspense>;
}

function RoomContent({ room, location }) {
  if (room.kind === 'redirect') return null;
  if (room.kind === 'home') return <ShellHome />;
  if (room.kind === 'neutral') {
    const { Component, props } = room.neutral;
    return <Suspense fallback={<RoomFallback />}><Component {...(props ?? {})} /></Suspense>;
  }
  const { product } = room;
  const spot = { hash: location.hash, pathname: location.pathname, search: location.search };
  // A bare room URL mounts the product at its own home, never written to the URL.
  const match = product.render(spot) ?? product.render({ ...spot, hash: product.home() });
  if (!match) return null;
  const { Component, props } = match;
  return <Suspense fallback={<RoomFallback Ghost={product.shell.Ghost} />}><Component {...props} /></Suspense>;
}

export function Shell({ location, neutral = null }) {
  const { user, status, signOut } = useAuth();
  const openSignInDoor = useSignInDoor();
  const lendDoorSkin = useSignInDoorHost();
  const { resolved: appearance } = useAppearance();
  const room = resolveRoom(location.pathname, neutral);
  const redirect = room.redirect ?? null;
  const theme = room.scope.theme ?? appearance;

  // Attributes only: scripts/appBoot.js emits the rule that paints the ground off data-wm-boot.
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.setAttribute('data-wm-boot', 'app');
    html.setAttribute('data-brand', room.scope.brand);
    html.setAttribute('data-theme', theme);
  }, [room.scope.brand, theme]);

  // Handed back on unmount only: a room switch must not pass through an unstamped frame.
  useLayoutEffect(() => () => {
    const html = document.documentElement;
    html.removeAttribute('data-wm-boot');
    html.removeAttribute('data-brand');
    html.removeAttribute('data-theme');
    html.style.removeProperty('--wm-boot-ground');
    // The boot script parked each meta's original content in `data-was`.
    for (const name of ['theme-color', 'color-scheme']) {
      const meta = document.querySelector(`meta[name="${name}"]`);
      if (meta?.dataset.was) meta.setAttribute('content', meta.dataset.was);
    }
  }, []);

  useEffect(() => {
    if (!redirect) return;
    if (redirect.external) { window.location.replace(redirect.href); return; }
    navigate(redirect.href, { replace: true });
  }, [redirect?.href, redirect?.external]);

  return (
    <div className="wm-shell" ref={lendDoorSkin} data-brand={room.scope.brand} data-theme={theme}>
      <header className="wm-head">
        <a className="wm-head-mark" href="/" title="Windmill" aria-label="Windmill — home">W</a>
        <nav className="wm-switch" aria-label="Rooms">
          <RoomLink href="/app" label="Home" active={room.kind === 'home' && !redirect} />
          {PRODUCTS.filter((p) => p.shell?.status === 'open').map((p) => (
            <RoomLink key={p.id} href={p.shell.room} label={p.label} active={room.product?.id === p.id} />
          ))}
        </nav>
        {/* The seat is always clay; both scope attributes ride together, keyed on the pair. */}
        <div className="wm-head-seat" data-brand="clay" data-theme={theme}>
          <AccountSeat
            user={user}
            status={status}
            size={30}
            onSignIn={openSignInDoor}
            onSettings={() => navigate('/app/settings')}
            onConnect={() => navigate('/app/connect')}
            onSignOut={signOut}
          />
        </div>
      </header>
      <main className="wm-room">
        <RoomContent room={room} location={location} />
      </main>
    </div>
  );
}

export default Shell;
