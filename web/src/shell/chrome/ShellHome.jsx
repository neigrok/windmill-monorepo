// The /app home room — the product grid. Open products speak for themselves through their
// registry HomeCard (product-owned truth, lazy); pre-open products get the shell's own no-door
// cell, because a landing must never offer a door that opens onto nothing. The status line is
// read off the registry, never hard-coded.

import React, { Suspense } from 'react';
import { PRODUCTS } from '../products.js';
import { InstallChip } from '../pwa/InstallChip.jsx';

function joinLabels(labels) {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function statusLine(open, preOpen) {
  const openPart = open.length ? `${joinLabels(open.map((p) => p.label))} ${open.length === 1 ? 'is' : 'are'} open today` : '';
  const prePart = preOpen.length ? `${joinLabels(preOpen.map((p) => p.label))} ${preOpen.length === 1 ? 'joins when it opens' : 'join when they open'}` : '';
  if (openPart && prePart) return `${openPart}; ${prePart}.`;
  if (openPart) return `${openPart}.`;
  if (prePart) return `${prePart}.`;
  return '';
}

export function ShellHome() {
  const products = PRODUCTS.filter((p) => p.shell);
  const open = products.filter((p) => p.shell.status === 'open');
  const preOpen = products.filter((p) => p.shell.status !== 'open');
  return (
    <div className="wm-home">
      <p className="wm-home-status">{statusLine(open, preOpen)}</p>
      <div className="wm-home-grid">
        {/* An open product without a HomeCard (registry not yet grown) renders nothing —
            the shell never invents a product's cell. */}
        {open.map((p) => (p.shell.HomeCard
          ? (
            <Suspense key={p.id} fallback={<div className="wm-home-cell wm-home-cell--resolving" aria-hidden="true" />}>
              <p.shell.HomeCard />
            </Suspense>
          )
          : null))}
        {preOpen.map((p) => (
          <div key={p.id} className="wm-home-cell wm-home-cell--preopen">
            <div className="wm-home-cell-head">
              <span className="wm-home-dot" aria-hidden="true" />
              <span className="wm-home-cell-name">{p.label}</span>
              <span className="wm-home-cell-tag">in design</span>
            </div>
            <p className="wm-home-cell-body">No door yet — a landing must never offer a door that opens onto nothing.</p>
            <a className="wm-home-cell-link" href={p.shell.landingHref}>See what’s coming →</a>
          </div>
        ))}
      </div>
      <InstallChip />
    </div>
  );
}

export default ShellHome;
