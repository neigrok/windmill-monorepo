// The product registry — the one place the shell learns which products exist.

import { roadmapRoutes } from '../products/roadmap/routes.js';
import { journalRoutes } from '../products/journal/routes.js';
import { gymRoutes } from '../products/gym/routes.js';
import { t } from './i18n/index.js';

// In rail order; a product holds itself shut through `shell.status: 'pre-open'` in its route table.
export const PRODUCTS = [roadmapRoutes, journalRoutes, gymRoutes];

export function joinLabels(labels) {
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return t('shell.list.pair', { first: labels[0], last: labels[1] });
  return t('shell.list.series', { first: labels[0], rest: joinLabels(labels.slice(1)) });
}

export function activeProduct(hash = typeof window === 'undefined' ? '' : window.location.hash) {
  return PRODUCTS.find((p) => hash.startsWith(p.switchHash)) ?? PRODUCTS[0];
}

export function homeHash(hash) {
  return activeProduct(hash).home();
}
