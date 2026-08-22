// The /app shell — the common ground behind the landings. One minimal chrome hosts every product
// as a room: the room switcher centred at the head, the account seat opposite it, and the room
// under both. No rail, no top bar, no chrome lines — the shell draws two pieces of furniture and
// then gets out of the way, because the room is the thing worth looking at (design canon,
// templates/app-shell). The registry (../products.js) is the only window into the products.
//
// The shell owns theme scope: data-brand comes from the active room's registry scope, and
// data-theme is the app's one appearance choice (shell/appearance.js) unless the room PINS its own.
// Both are stamped on the shell root together, which is exactly what lets styles/tokens/palettes.css
// hand the room its ground — the ground blocks are keyed on the PAIR, so a landing (brand alone)
// keeps the family cream while a room gets its place. The same pair is echoed onto <html>, where
// the boot script put it before React existed, so the ground BEHIND the shell stays the room's own
// through a switch too. The shell itself runs zero infinite animations — the calm ceiling is the
// room's budget.
//
// The room's own tabs would ride at the foot, one per canon; no product asks the shell for tabs
// today (each draws its own navigation inside its room), and the shell never paints a tab a room
// did not ask for — so there is no footer here rather than an empty one.

import React, { Suspense, useEffect, useLayoutEffect } from 'react';
import { PRODUCTS } from '../products.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { AccountSeat } from '../auth/AccountSeat.jsx';
import { useSignInDoor, useSignInDoorHost } from '../auth/SignInDoor.jsx';
import { useAppearance } from '../useAppearance.js';
import { ShellHome } from './ShellHome.jsx';
import './chrome.css';

// In-shell navigation: swap the pathname without a reload and wake the router. App.jsx's /app
// router listens to popstate; a modified click (new-tab intent) falls through to the real href.
function navigate(href, { replace = false } = {}) {
  if (replace) window.history.replaceState({}, '', href);
  else window.history.pushState({}, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

// One door in the switcher. A room is named in words rather than drawn as a glyph: three or four
// short labels read faster than three or four icons anyone has to learn, and the same row is the
// whole chrome at every width.
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

// The decision table: neutral prop → that room verbatim; /app → home; an open product's
// shell.room prefix → its room; a pre-open room → replace-redirect to the landing (no door
// onto nothing); anything else under /app → replace-redirect home. Products without a `shell`
// registry entry don't exist to the chrome. No room carries a title: the chrome names the
// ROOMS in its switcher and the room writes its own heading, so a title here would be a second
// place for the same word to be right or wrong.
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

// The wait between the room being asked for and the room arriving. It is the room's own ground and
// nothing else — the same ground the boot script already painted, so there is no second full-screen
// repaint and nothing to read. A product may hand the chrome a Ghost to stand on that ground after
// a beat; one that hands nothing gets the ground alone, which is the honest answer for a room whose
// layout cannot be guessed. The chrome still names no product: the ghost arrives off the registry.
// A fallback may not itself suspend, and every component on the registry is a lazy handle — so the
// ghost gets its OWN boundary here, with the bare ground under it. That is not a workaround, it is
// the same rule one layer down: until the ghost's own chunk lands there is ground and nothing else,
// which is what a room this fast to arrive should have shown anyway.
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
  // A bare room URL mounts the product at its own home — synthesized, never written to the URL.
  const match = product.render(spot) ?? product.render({ ...spot, hash: product.home() });
  if (!match) return null;
  const { Component, props } = match;
  return <Suspense fallback={<RoomFallback Ghost={product.shell.Ghost} />}><Component {...props} /></Suspense>;
}

export function Shell({ location, neutral = null }) {
  const { user, status, signOut } = useAuth();
  const openSignInDoor = useSignInDoor();
  const lendDoorSkin = useSignInDoorHost();
  // A room may PIN its theme (gym's instrument skin is basalt whatever this says); a room that pins
  // nothing follows the app's one appearance choice.
  const { resolved: appearance } = useAppearance();
  const room = resolveRoom(location.pathname, neutral);
  const redirect = room.redirect ?? null;
  const theme = room.scope.theme ?? appearance;

  // THE GROUND BEHIND THE ROOM. The boot script in index.html stamped this exact pair on <html>
  // before the first paint — that is what makes the page the room's own colour while the bundle is
  // still downloading. Here we AGREE with it rather than re-decide it: on a first mount these are
  // the values already there, so nothing repaints, and on an in-app room switch or a change of
  // appearance the ground follows the room instead of being frozen at whatever booted.
  //
  // Only the attributes: the ground itself is painted by the rule the boot emits alongside the
  // script (scripts/appBoot.js), which keys on this very data-wm-boot and reads --surface-canvas.
  // Setting a background here as well would be a second mechanism for one colour.
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.setAttribute('data-wm-boot', 'app');
    html.setAttribute('data-brand', room.scope.brand);
    html.setAttribute('data-theme', theme);
  }, [room.scope.brand, theme]);

  // And handed back on the way out, because leaving /app is NOT always a document load: the mark in
  // the head is an ordinary link to `/`, and App.jsx answers it with a pushState. Left stamped, the
  // brand root would paint its cream hero on the room's night. Only on unmount — a room SWITCH must
  // not pass through an unstamped frame, which is the repaint this whole wave exists to remove.
  useLayoutEffect(() => () => {
    const html = document.documentElement;
    html.removeAttribute('data-wm-boot');
    html.removeAttribute('data-brand');
    html.removeAttribute('data-theme');
    html.style.removeProperty('--wm-boot-ground');
    // And the browser's own chrome, back to whatever the document shipped with. The boot parked
    // that in `data-was` on each meta rather than telling the shell a colour, which is not the
    // shell's to know (scripts/appBoot.js).
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
        {/* The seat is the one thing off-centre, and the one thing that is always clay: it belongs
            to the shell rather than to the room it happens to be standing in (canon superapp-shell
            §6). Both scope attributes ride together — clay's dark hue is keyed on the pair, so a
            lone data-brand would hand a dark room the light terracotta. */}
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
