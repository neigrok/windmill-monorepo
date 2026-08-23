// The product registry — the one place the shell learns which products exist.

import { roadmapRoutes } from '../products/roadmap/routes.js';
import { journalRoutes } from '../products/journal/routes.js';
import { gymRoutes } from '../products/gym/routes.js';

// In rail order; a product holds itself shut through `shell.status: 'pre-open'` in its route table.
export const PRODUCTS = [roadmapRoutes, journalRoutes, gymRoutes];

export function joinLabels(labels) {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

export function activeProduct(hash = typeof window === 'undefined' ? '' : window.location.hash) {
  return PRODUCTS.find((p) => hash.startsWith(p.switchHash)) ?? PRODUCTS[0];
}

export function homeHash(hash) {
  return activeProduct(hash).home();
}
