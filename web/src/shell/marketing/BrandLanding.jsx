// The brand front door at the bare root; every door is read from the registry.

import React from 'react';
import { Badge, Button } from '../../design-system';
import { PRODUCTS, homeHash } from '../products.js';
import { LandingPage } from './LandingChrome.jsx';
import './landing.css';

function ProductDoor({ product }) {
  const { label, landing, shell } = product;
  const open = shell.status === 'open';
  const verb = open ? `Explore ${label}` : 'See what’s coming';
  const doorLabel = open ? verb : `${label} — ${verb}`;
  return (
    <a
      className="trioItem"
      href={landing.href}
      aria-label={doorLabel}
      style={{
        height: '100%',
        boxSizing: 'border-box',
        padding: '26px 24px',
        background: 'var(--surface-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div className="eyebrow">{landing.tagline}</div>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h3 className="trioTitle">{label}</h3>
        {shell.status === 'pre-open' && <Badge tone="neutral">Not open yet</Badge>}
      </div>
      <p className="trioCopy" style={{ flex: 1 }}>{landing.summary}</p>
      <span style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 15 }}>{verb} →</span>
    </a>
  );
}

export function BrandLanding() {
  const start = PRODUCTS.find((p) => p.shell.status === 'open') ?? null;
  const cta = start ? { href: start.landing.href, label: 'Start' } : null;

  return (
    <LandingPage
      brand={null}
      product={null}
      links={[]}
      cta={cta}
      resume={{ href: homeHash(), label: 'Open Windmill' }}
    >
      <section className="wrap" style={{ paddingTop: 40, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Badge tone="brand" dot>Now in public beta</Badge>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'clamp(36px, 5.2vw, 60px)', lineHeight: 1.07, color: 'var(--text-primary)', margin: '20px 0 16px', maxWidth: 820, textWrap: 'pretty' }}>
          Grow, gently.
        </h1>
        <p style={{ fontFamily: 'var(--font-body)', fontSize: 'clamp(16px, 2vw, 20px)', lineHeight: 1.5, color: 'var(--text-secondary)', maxWidth: 620, margin: 0, textWrap: 'pretty' }}>
          Three quiet tools for looking after yourself — a roadmap for what you’re learning, a journal
          for what you’re noticing, and a log for how you’re training. One account. One
          subscription.
        </p>
        {start && (
          <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap', justifyContent: 'center' }}>
            <a href={start.landing.href}><Button variant="primary" size="lg">{`Start with ${start.label}`}</Button></a>
          </div>
        )}
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13.5, color: 'var(--text-tertiary)', marginTop: 14 }}>
          Free to use by hand, all of it. The paid layer is the AI doing the work for you — and it is
          not on sale yet.
        </div>
      </section>

      <section className="wrap" style={{ paddingTop: 96 }}>
        <div className="eyebrow">The products</div>
        <h2 className="sectionTitle">Three tools, one account</h2>
        <div className="trio" style={{ marginTop: 24 }}>
          {PRODUCTS.map((product) => <ProductDoor key={product.id} product={product} />)}
        </div>
      </section>

      <section className="wrap" style={{ paddingTop: 96 }}>
        <div className="ctaBand">
          <h2 className="sectionTitle" style={{ margin: 0 }}>Start with one</h2>
          <p className="sectionSub" style={{ maxWidth: 460 }}>
            Whichever tool you open, it’s the same account — and the roadmap doesn’t need one to begin.
          </p>
          {start && (
            <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap', justifyContent: 'center' }}>
              <a href={start.landing.href}><Button variant="primary" size="lg">{`Start with ${start.label}`}</Button></a>
            </div>
          )}
        </div>
      </section>
    </LandingPage>
  );
}
