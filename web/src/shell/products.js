// The product registry — the one place the shell learns which products exist. Each product
// exports a uniform route table (id · label · switchHash · home · render, plus the `shell`
// manifest the /app chrome reads: room · scope · status · landingHref · HomeCard, the
// `landing` the brand root builds its door from: href · Component · tagline · summary, the
// optional `settingsSections: { main, data }` the neutral settings page composes — `main` in the
// product zone under the account identity, `data` last beside the account's own close, and a
// product with none contributes nothing — and the optional `forgetDevice({ previous, next })` the
// shell calls when the signed-in account CHANGES: a sign-out (`next: null`) or one account
// replacing another, so a product gives up what it keeps on this device before the next person on
// this browser can read it. It is never called for ghost→signed-in — that is the claim, and the
// anonymous work is meant to follow the person who signs in — and a product that keeps nothing on
// the device declares none). The
// shell composes them in this order and names the rooms in its head from the same list. The shell
// hard-codes no product: when a neutral surface (account, sign-in landing) needs to know where
// "home" is, it asks the active product here, defaulting to the first — the roadmap, for now.
// This registry is the ONLY meeting point between chrome and products — the boundary test
// (test/shell-boundaries.test.mjs) enforces that from both sides.

import { roadmapRoutes } from '../products/roadmap/routes.js';
import { journalRoutes } from '../products/journal/routes.js';
import { gymRoutes } from '../products/gym/routes.js';

// Three products, in rail order. All three are open. A product that is not ready holds itself shut
// through `shell.status: 'pre-open'` in its own route table — readiness is a flag a product sets,
// never something the shell infers from whether the product has code.
export const PRODUCTS = [roadmapRoutes, journalRoutes, gymRoutes];

// How the shell speaks about a SET of products — "Roadmap, Journal and Gym". It lives beside the
// registry because that is the only place allowed to know what the set is; every neutral surface
// that has to name the whole house (the /app home's status line, the account-close consent) reads
// its words from here rather than writing a list that goes stale the day a fourth product lands.
export function joinLabels(labels) {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

// The active product is whichever one owns the current hash; on a product-neutral surface
// (sign-in, settings, connect, the landing) it falls back to the first product — nothing about
// "home" is roadmap-specific in the shell itself.
export function activeProduct(hash = typeof window === 'undefined' ? '' : window.location.hash) {
  return PRODUCTS.find((p) => hash.startsWith(p.switchHash)) ?? PRODUCTS[0];
}

// Where "back to the app" goes from a neutral surface — the active product's own home.
export function homeHash(hash) {
  return activeProduct(hash).home();
}
