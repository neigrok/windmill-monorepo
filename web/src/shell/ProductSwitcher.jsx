// The product switcher — three entries, one per product, read straight from the registry.
// The shell hard-codes nothing: add a product to shell/products.js and it appears here and
// in the router both. Each entry links to that product's switchHash; the current one is marked.

import React from 'react';
import { PRODUCTS } from './products.js';

export function ProductSwitcher({ current }) {
  return (
    <nav style={row} aria-label="Products">
      {PRODUCTS.map((p) => (
        <a key={p.id} href={p.switchHash} aria-current={p.id === current ? 'page' : undefined}
          style={{ ...pill, ...(p.id === current ? pillOn : null) }}>
          {p.label}
        </a>
      ))}
    </nav>
  );
}

export default ProductSwitcher;

const row = { display: 'inline-flex', gap: 4, background: 'var(--surface-canvas)', borderRadius: 'var(--radius-full)', padding: 4 };
const pill = {
  fontFamily: 'var(--font-body)', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-tertiary)',
  textDecoration: 'none', borderRadius: 'var(--radius-full)', padding: '6px 14px',
};
const pillOn = { background: 'var(--neutral-0)', color: 'var(--text-primary)', fontWeight: 800, boxShadow: 'var(--shadow-xs)' };
