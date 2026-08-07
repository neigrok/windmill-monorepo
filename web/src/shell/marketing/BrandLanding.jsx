// The brand front door at the bare root — product-neutral, and now the same page shape as its three
// siblings: the family chrome renders the nav, the auth cluster and the legal shelf, so switching
// between / and /roadmap no longer moves the wordmark. What is left here is what only the brand root
// can say: Windmill is one account over three tools, and here are the three doors. The doors are read
// from the registry — label, landing href, true state, and the two lines each product writes about
// itself — so this page holds no sentence about a product and cannot outlive one's status. The badge
// is `shell.status` and nothing else for the same reason: invent a word for it here and a visitor
// clicking Gym is told its state changed between two pages of one family. It stays eager and
// indexed, shipping with the entry chunk.

import React from 'react';
import { Badge, Button } from '../../design-system';
import { PRODUCTS, homeHash } from '../products.js';
import { LandingPage } from './LandingChrome.jsx';
import './landing.css';

function ProductDoor({ product }) {
  const { label, landing, shell } = product;
  const open = shell.status === 'open';
  const verb = open ? `Explore ${label}` : 'See what’s coming';
  // The whole card is the door — without a name of its own, a screen reader reads the entire
  // paragraph out as the link.
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
        {/* "Not open yet", never "In design" — the same words the /app home cell uses. A pre-open
            product here is one whose ROOM has not opened; it is not a product nobody has built.
            Gym is finished and reachable at its own landing, and a badge calling it a design was
            the brand root telling a visitor something the next click contradicts. */}
        {shell.status === 'pre-open' && <Badge tone="neutral">Not open yet</Badge>}
      </div>
      <p className="trioCopy" style={{ flex: 1 }}>{landing.summary}</p>
      <span style={{ fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 15 }}>{verb} →</span>
    </a>
  );
}

export function BrandLanding() {
  // The brand root has one door, not three: the first product the registry calls open. Derived, so
  // the day gym opens or a product closes the front door moves with it instead of lying.
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
          Free to use by hand, all of it. The paid layer is only ever the AI doing the work for you.
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
