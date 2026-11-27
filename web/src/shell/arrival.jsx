// What the document arrived with, read before React replaces it. A landing's first HTML is its whole page, written at
// build time (scripts/build-landing-shells.mjs): a landing stands on it while its code loads and keeps it, links and all,
// when the code cannot load (a failed chunk, a failed stylesheet, a session provider that throws), which reports once to
// Sentry as `landing-<page>` with no stack; anywhere else a crash is the boundary's own screen and report. And whether
// the person has moved the page since, so a shared section link never pulls away someone already reading.

import React from 'react';
import { reportError } from '../telemetry/beacon.js';
import { captureError } from '../telemetry/sentry.js';
import { readNavigation } from './navigation.js';

const MOVES = ['wheel', 'touchstart', 'keydown', 'pointerdown'];
let arrived = null;
let moved = false;

// `pages` names each landing's address by the page its failure reports under. Call it before the first render.
export function keepArrival(root, pages) {
  const page = pages[window.location.pathname];
  if (page) arrived = { pathname: window.location.pathname, page, html: root.innerHTML };
  const stop = () => {
    moved = true;
    MOVES.forEach((type) => window.removeEventListener(type, stop, true));
  };
  MOVES.forEach((type) => window.addEventListener(type, stop, { capture: true, passive: true }));
}

export function movedSinceArrival() {
  return moved;
}

// The landing the document arrived on, while it still stands on that address.
function standing() {
  return arrived && readNavigation().pathname === arrived.pathname ? arrived : null;
}

// The arrived landing's first HTML while the document still stands on its address, else null: what a route shows while
// its code loads, and what the app's outermost boundary leaves after a crash.
export function arrivedPage() {
  const page = standing();
  return page ? <div dangerouslySetInnerHTML={{ __html: page.html }} /> : null;
}

export function reportCrash(error) {
  const page = standing();
  if (page) captureError('render', `landing-${page.page}`, '', page.pathname);
  else reportError(error, 'render');
}
