// The product registry — the one place the shell learns which products exist. Each product
// exports a uniform route table (id · label · switchHash · home · render, plus the `shell`
// manifest the /app chrome reads: icon · room · scope · status · landingHref · HomeCard, the
// `landing` the brand root builds its door from: href · Component · tagline · summary, and the
// optional `settingsSections: { main, data }` the neutral settings page composes — `main` in the
// product zone under the account identity, `data` last beside the account's own close, and a
// product with none contributes nothing); the
// shell composes them in this order and renders the rail from the same list. The shell
// hard-codes no product: when a neutral surface (account, sign-in landing) needs to know where
// "home" is, it asks the active product here, defaulting to the first — the roadmap, for now.
// This registry is the ONLY meeting point between chrome and products — the boundary test
// (test/shell-boundaries.test.mjs) enforces that from both sides.

import { roadmapRoutes } from '../products/roadmap/routes.js';
import { journalRoutes } from '../products/journal/routes.js';
import { gymRoutes } from '../products/gym/routes.js';

// Journal is the daily-notes product, designed and built out — it takes the second slot the `notes`
// scaffold reserved. gym stays a scaffold until it grows code.
export const PRODUCTS = [roadmapRoutes, journalRoutes, gymRoutes];

// The active product is whichever one owns the current hash; on a product-neutral surface
// (sign-in, settings, connect, the landing) it falls back to the first product. This is the
// seam notes/gym slot into — nothing about "home" is roadmap-specific in the shell itself.
export function activeProduct(hash = typeof window === 'undefined' ? '' : window.location.hash) {
  return PRODUCTS.find((p) => hash.startsWith(p.switchHash)) ?? PRODUCTS[0];
}

// Where "back to the app" goes from a neutral surface — the active product's own home.
export function homeHash(hash) {
  return activeProduct(hash).home();
}
