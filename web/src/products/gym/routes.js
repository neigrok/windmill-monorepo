// The gym product's route table — the same uniform shape roadmap and journal export, so the shell
// composes all three through one loop. #/gym is Today, #/gym/log the log, #/gym/routines the
// routines and #/gym/stats the statistics; one session, one routine, one finished session and the
// past-workout door hang off those (log.js holds the grammar). GymApp resolves the exact position
// off the hash — including #/gym/shared/…, the coach's read-only workout, which is the one position
// here that resolves for a visitor with no account at all.

import { lazy } from 'react';
import { gymLandingHead } from './marketing/landingHead.js';

const importGymApp = () => import('./GymApp.jsx').then((m) => ({ default: m.GymApp }));
const GymApp = lazy(importGymApp);

// The gym's cell on the /app home grid. Lazy, like every other HomeCard, and for the sharpest
// version of the reason: the grid is the first frame after sign-in, and this cell is three lines
// of text read off this device.
const HomeCard = lazy(() => import('./HomeCard.jsx').then((m) => ({ default: m.HomeCard })));

// The gym's own landing at /gym. It has to recognise a signed-in visitor on the first frame, which
// is why it is React here and no longer a static page under public/.
const importGymLanding = () => import('./marketing/GymLanding.jsx').then((m) => ({ default: m.GymLanding }));
const GymLanding = lazy(importGymLanding);

// The training log's one account-settings section — registered here so the neutral settings page
// composes it without ever naming the gym (shell/settings/SettingsPage.jsx reads settingsSections
// off the product registry). `data` renders last, beside the account's own close. Lazy, so it keeps
// its own chunk and never weighs on a settings page opened by somebody who has never trained: it
// draws nothing at all until it has read that this account has a log.
const GymDataSection = lazy(() => import('./settings/GymDataSection.jsx').then((m) => ({ default: m.GymDataSection })));

function home() {
  return '#/gym';
}

// Where a fresh sign-in lands when gym is the active product: Today, the same room `home` names.
// Without this the shell falls back to PRODUCTS[0] and a lifter signing in from gym lands on the
// skill tree.
function landingAfterSignIn() {
  return home();
}

// ONE PRODUCT, TWO FRAMES. Gym is drawn either as the bare surface at #/gym — where nothing but
// GymApp paints anything, so it floats its own account seat and product switcher — or as a room
// inside the /app shell, which already draws a seat (the rail's foot on a desk, the top bar's on a
// phone) and whose rail IS the switcher. A room that drew its own inside the shell would paint a
// second account seat next to the first.
//
// Decided here rather than inside the app, off the pathname the caller hands the route table —
// exactly as roadmap's own render reads `pathname` to tell a /t/:id share page from an editor.
// That matters for more than tidiness: the shell resolves the room and the legacy-door upgrade in
// the same render that mounts this component, so `window.location.pathname` read from inside can
// still be the pre-upgrade one. What arrives here is the pathname the frame actually resolved.
function inShellRoom(pathname) {
  return pathname === '/app' || (pathname ?? '').startsWith('/app/');
}

function render({ hash, pathname }) {
  if (hash.startsWith('#/gym')) return { Component: GymApp, props: { hash, inShell: inShellRoom(pathname) } };
  return null;
}

export const gymRoutes = {
  id: 'gym',
  label: 'Gym',
  switchHash: '#/gym',
  home,
  landingAfterSignIn,
  render,
  preloadApp: importGymApp,
  settingsSections: {
    data: [GymDataSection],
  },
  // The words the brand root's door for the gym is made of. The state beside them is the brand
  // root's own, read off `shell.status` below — so these two lines describe the product and never
  // date themselves against it.
  landing: {
    head: gymLandingHead,
    href: '/gym',
    Component: GymLanding,
    preload: importGymLanding,
    tagline: 'Keep a training log',
    summary: 'A quiet record of how you’re moving — sets, sessions, the long line of showing up. Two taps between sets, and the next session opens with last time’s numbers already in the field.',
  },
  shell: {
    icon: 'dumbbell',
    room: '/app/gym',
    scope: { theme: 'dark', brand: 'gym' },
    // THE ONE LINE THAT OPENS THE GYM, and it is a launch decision rather than a build one — the
    // phase-1 dogfood gate has never run, and that gate is what says whether this product is good.
    // Everything the flip needs is built, so moving 'pre-open' to 'open' is the whole edit:
    //
    //   · the rail button, the mobile tab, the /app home cell, the legacy door (#/gym upgrading in
    //     place to /app/gym), the room itself and the brand root's badge are all DERIVED from this
    //     word. Nothing outside this line spells gym's state out by hand.
    //   · the HomeCard above is what the grid draws once it is open. Without one, an open product
    //     is absent from the grid rather than present in it (chrome/ShellHome.jsx), which is the
    //     failure this comment exists to make impossible.
    //   · in-shell chrome is settled: `render` hands GymApp `inShell`, and the app draws its own
    //     seat and switcher only outside the shell.
    //
    // What the flip still implies, and what nobody should discover afterwards:
    //   · ONE TEST FAILS ON THE FLIP, and it is the shell's: test/shell/settings/accountClosure.test.js
    //     asserts at least one registered product is pre-open, so that the account-close deal is
    //     proved to name a product with no door. With gym open there is none, and `npm run build`
    //     stops. Nothing in gym's own suite pins the word — this comment is deliberately the only
    //     place it is discussed.
    //   · #/gym/shared/<token> upgrades too, because the legacy door matches on the '#/gym' prefix
    //     (shell/App.jsx). A coach opening a link they were sent would then read that one workout
    //     inside the app's chrome — a rail, a Sign in seat — rather than on the bare page this
    //     product deliberately hands them. Either the door has to learn about that one sub-path or
    //     the coach's page needs a hash outside the '#/gym' prefix.
    //   · the shell's pre-open cell and the brand root's door both stop drawing "In design", which
    //     is correct — and both of those words are the shell's, derived, so neither needs an edit.
    //     Until then they are the one place left that still calls a finished product a design: the
    //     /app grid's cell reads "in design · No door yet" beside a landing that now opens the log.
    //     That copy is the shell's (chrome/ShellHome.jsx) and is filed for whoever owns it.
    //   · gym still requires an account. #/gym answers a ghost with a sign-in pitch, and the rail
    //     will offer the room to one. That is stated at every door that leads there (the HomeCard,
    //     the landing's trust line) and it is a precondition, not a bug.
    status: 'pre-open',
    landingHref: '/gym',
    HomeCard,
  },
};
