// The OAuth `scope` string is space-delimited `<product>:<level>`. An empty scope is the
// account-wide grant; a scope this build cannot read confers nothing.

import { t } from '../i18n/settings/index.js';

const PRODUCTS = {
  roadmap: t('shell.scopes.roadmap'),
  journal: t('shell.scopes.journal'),
  gym: t('shell.scopes.gym'),
};

const LEVELS = {
  read: { glyph: 'dim', word: t('shell.scopes.read'), line: (product) => t('shell.scopes.readLine', { product }) },
  write: { glyph: 'bud', word: t('shell.scopes.write'), line: (product) => t('shell.scopes.writeLine', { product }) },
  delete: { glyph: 'gone', word: t('shell.scopes.delete'), line: (product) => t('shell.scopes.deleteLine', { product }) },
};

const LEVEL_ORDER = ['read', 'write', 'delete'];

function productLabel(product) {
  return PRODUCTS[product] ?? product;
}

// accountWide is the '' grant only: an unreadable scope answers accountWide:false with no products.
export function readScope(scope) {
  const tokens = String(scope ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { accountWide: true, products: [] };

  const byProduct = new Map();
  for (const token of tokens) {
    const colon = token.lastIndexOf(':');
    if (colon <= 0 || colon === token.length - 1) continue;
    const product = token.slice(0, colon);
    const level = token.slice(colon + 1);
    if (!LEVELS[level]) continue;
    if (!byProduct.has(product)) byProduct.set(product, new Set());
    byProduct.get(product).add(level);
  }

  return {
    accountWide: false,
    products: [...byProduct].map(([product, levels]) => ({
      product,
      label: productLabel(product),
      levels: LEVEL_ORDER.filter((level) => levels.has(level)),
    })),
  };
}

export function capabilityGroups(scope) {
  return readScope(scope).products.map((group) => ({
    product: group.product,
    label: group.label,
    lines: group.levels.map((level) => ({
      level,
      glyph: LEVELS[level].glyph,
      label: LEVELS[level].line(group.label),
    })),
  }));
}

// `reach` is 'everything' (account-wide), 'nothing' (unreadable) or 'listed'; the first two draw
// zero capability lines, so a card may not branch on the line count.
export function consentSummary(scope) {
  const { accountWide, products } = readScope(scope);
  if (accountWide) return { reach: 'everything', groups: [], canDelete: true };
  if (products.length === 0) return { reach: 'nothing', groups: [], canDelete: false };
  return {
    reach: 'listed',
    groups: capabilityGroups(scope),
    canDelete: products.some((group) => group.levels.includes('delete')),
  };
}

export function summarizeScope(scope) {
  const { accountWide, products } = readScope(scope);
  if (accountWide) return t('shell.scopes.everything');
  if (products.length === 0) return t('shell.scopes.nothing');
  return products.map((group) => t('shell.scopes.summary', { product: group.label, levels: group.levels.map((level) => LEVELS[level].word).join(', ') })).join(' · ');
}
