// The product registry — the one place the shell learns which products exist. Each product
// exports a uniform route table (id · label · switchHash · home · render); the shell composes
// them in this order and renders the switcher from the same list. The shell hard-codes no
// product: when a neutral surface (account, sign-in landing) needs to know where "home" is,
// it asks the active product here, defaulting to the first — the roadmap, for now.

import { roadmapRoutes } from '../products/roadmap/routes.js';
import { notesRoutes } from '../products/notes/routes.js';
import { gymRoutes } from '../products/gym/routes.js';

export const PRODUCTS = [roadmapRoutes, notesRoutes, gymRoutes];

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
