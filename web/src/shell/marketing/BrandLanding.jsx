// The brand front door at the bare root: every OPEN product's hero band and section, composed off
// the registry's `landing.root`, each on that product's own palette. A product still holding itself
// shut brings no band and no section — the page would otherwise hand it a full pitch and a live
// door — but keeps its place in the cross-nav and the footer, where it reads as a tool that exists.

import React, { Suspense, useEffect } from 'react';
import { BrandWordmark, Button } from '../../design-system';
import { PRODUCTS, homeHash } from '../products.js';
import { useAppearance } from '../useAppearance.js';
import { LandingPage } from './LandingChrome.jsx';
import { BRAND_PROMISE, START_FREE } from './landingHeads.js';
import './landing.css';

function HeroBand({ product, theme }) {
  const { id, label, landing } = product;
  const { platforms, band, reserve, Glimpse } = landing.root;
  return (
    <section className="rootBand" data-brand={id} data-theme={theme}>
      <div className="wrap rootBand-grid">
        <div className="rootBand-words">
          <div className="rootEyebrow"><i aria-hidden="true" />{label} · {platforms}</div>
          <h2 className="rootBand-title">{band.title}</h2>
          <p className="rootBand-sub">{band.sub}</p>
        </div>
        <div className="rootBand-scene" style={{ '--rootScene-reserve': reserve?.band }}>
          <Suspense fallback={null}><Glimpse /></Suspense>
        </div>
        <a className="rootBand-link" href={`#${id}`}>See {label} ↓</a>
      </div>
    </section>
  );
}

// Scenes alternate sides down the page: the first stands right of its words, the second left.
function ProductSection({ product, theme, sceneLeft }) {
  const { id, label, landing } = product;
  const { platforms, section, reserve, Illustration } = landing.root;
  return (
    <section id={id} className={sceneLeft ? 'rootSection rootSection-sceneLeft' : 'rootSection'} data-brand={id} data-theme={theme}>
      <div className="wrap rootSection-grid">
        <div className="rootSection-words">
          <div className="rootEyebrow">{label} · {platforms}</div>
          <h2 className="rootSection-title">{section.title}</h2>
          <p className="rootSection-sub">{section.sub}</p>
        </div>
        <div className="rootSection-scene" style={{ '--rootScene-reserve': reserve?.section }}>
          <Suspense fallback={null}><Illustration /></Suspense>
        </div>
        <div className="rootSection-cta">
          <Button variant="primary" size="lg" href={section.cta.href}>{section.cta.label}</Button>
          <div className="rootSection-trust">{section.trust}</div>
        </div>
        <ul className="rootProof">
          {section.proof.map((card) => (
            <li key={card.title} className="rootProof-card">
              <h3 className="rootProof-title">{card.title}</h3>
              <p className="rootProof-copy">{card.copy}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function BrandLanding() {
  const { resolved: theme } = useAppearance();
  const open = PRODUCTS.filter((product) => product.shell.status === 'open');

  // The cross-nav mints /#roadmap, /#journal and /#gym into the address bar, so a bookmark, a share
  // or a reload arrives with the browser's fragment scroll already spent — it fired before this page
  // had drawn the section it names. Take the visitor there once the sections exist; landing.css
  // turns the smooth scroll off under reduced motion.
  useEffect(() => {
    const named = open.find((product) => window.location.hash === `#${product.id}`);
    if (named) document.getElementById(named.id).scrollIntoView();
  }, []);

  return (
    <LandingPage
      brand={null}
      product={null}
      links={[]}
      cta={START_FREE}
      resume={{ href: homeHash(), label: 'Open Windmill' }}
      anchored
    >
      {/* The page's one top-level heading, saying what the crawlable shell in web/index.html says.
          The design gives the front door no visible title — the bands speak for themselves — so
          this one is read, not seen, and the bands below it stay a level down. */}
      <h1 className="visually-hidden">{BRAND_PROMISE}</h1>

      {open.map((product) => <HeroBand key={product.id} product={product} theme={theme} />)}

      <div className="rootSeparator" role="presentation">
        <span className="rootSeparator-rule" />
        <span className="rootSeparator-beat">
          <BrandWordmark className="rootSeparator-mark" size={34} />
          <span className="rootSeparator-dot" />
          <span className="rootSeparator-phrase">{BRAND_PROMISE}</span>
        </span>
        <span className="rootSeparator-rule" />
      </div>

      {open.map((product, index) => (
        <ProductSection key={product.id} product={product} theme={theme} sceneLeft={index % 2 === 1} />
      ))}
    </LandingPage>
  );
}
