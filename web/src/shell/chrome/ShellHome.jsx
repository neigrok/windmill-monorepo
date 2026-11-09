import React, { Suspense } from 'react';
import { joinLabels, PRODUCTS } from '../products.js';
import { InstallChip } from '../pwa/InstallChip.jsx';
import { t } from '../i18n/app/index.js';

function statusLine(open, preOpen) {
  const openNames = joinLabels(open.map((p) => p.label));
  const preOpenNames = joinLabels(preOpen.map((p) => p.label));
  if (open.length && preOpen.length) return t('shell.home.statusBoth', { open: openNames, openCount: open.length, preOpen: preOpenNames, preOpenCount: preOpen.length });
  if (open.length) return t('shell.home.statusOpen', { products: openNames, count: open.length });
  if (preOpen.length) return t('shell.home.statusPreOpen', { products: preOpenNames, count: preOpen.length });
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
              <span className="wm-home-cell-tag">{t('shell.home.notOpen')}</span>
            </div>
            <p className="wm-home-cell-body">{t('shell.home.preOpenBody', { tagline: p.landing.tagline })}</p>
            <a className="wm-home-cell-link" href={p.shell.landingHref}>{t('shell.home.readAbout')}</a>
          </div>
        ))}
      </div>
      <InstallChip />
    </div>
  );
}

export default ShellHome;
