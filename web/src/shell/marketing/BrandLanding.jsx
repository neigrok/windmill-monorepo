// The brand front door at the bare root — product-neutral, unlike the roadmap landing it replaced
// (which now lives at /roadmap). Windmill is one brand of three self-growth tools behind one
// account and one subscription; this page says that and points into each product. It stays the eager,
// indexed root, so it ships with the entry chunk like the old landing did. A v1 scaffold: honest brand
// copy on the design system, to be deepened when the brand landing gets its own canon.

import React, { useState } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { requestMagicLink } from '../auth/AuthClient.js';
import { SignInDialog } from '../auth/SignInDialog.jsx';
import { Button } from '../../design-system';

const PRODUCTS = [
  {
    id: 'roadmap',
    name: 'Roadmap',
    tagline: 'Map what you’re learning',
    body: 'Author a learning path as an RPG skill tree — real prerequisites, ownership gates lifetimes, fundamentals gate frameworks. Grow it one checked-off node at a time.',
    href: '/roadmap',
    cta: 'Explore Roadmap',
    live: true,
  },
  {
    id: 'journal',
    name: 'Journal',
    tagline: 'Notice what happened',
    body: 'Free-form daily writing for people who want to understand themselves, not score themselves. One page a day, yesterday above it — and search that finds the feeling, not the word.',
    href: '/journal',
    cta: 'Explore Journal',
    live: true,
  },
  {
    id: 'gym',
    name: 'Gym',
    tagline: 'Keep a training log',
    body: 'A quiet record of how you’re moving — sets, sessions, the long line of showing up. Built on the same account, arriving soon.',
    href: '/gym',
    cta: 'See what’s coming',
    live: false,
  },
];

function ProductCard({ product }) {
  const card = (
    <div
      className="wm-brand-card"
      style={{
        display: 'flex', flexDirection: 'column', gap: 12, height: '100%',
        padding: '28px 26px', background: 'var(--surface-card)',
        border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-sm)', opacity: product.live ? 1 : 0.72,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'var(--text-xl)', color: 'var(--text-primary)' }}>{product.name}</h2>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', letterSpacing: '0.04em', color: 'var(--color-brand)', textTransform: 'uppercase' }}>{product.tagline}</span>
      </div>
      <p style={{ margin: 0, flex: 1, fontFamily: 'var(--font-body)', fontSize: 'var(--text-base)', lineHeight: 1.6, color: 'var(--text-secondary)' }}>{product.body}</p>
      <span style={{ marginTop: 6, fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 'var(--text-sm)', color: product.live ? 'var(--color-brand)' : 'var(--text-tertiary)' }}>
        {product.cta} →
      </span>
    </div>
  );
  if (!product.href) return card;
  return <a href={product.href} style={{ textDecoration: 'none' }} className="wm-brand-cardlink">{card}</a>;
}

export function BrandLanding() {
  const { user, status } = useAuth();
  const [signInOpen, setSignInOpen] = useState(false);
  const signedIn = status === 'signed-in' && Boolean(user);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface-canvas)', color: 'var(--text-primary)' }}>
      <style>{`
        .wm-brand-cardlink:hover .wm-brand-card { transform: translateY(-2px); box-shadow: var(--shadow-md); border-color: var(--border-default); }
        .wm-brand-card { transition: transform 160ms var(--ease-standard,cubic-bezier(.4,0,.2,1)), box-shadow 160ms, border-color 160ms; }
        .wm-brand-nav a { color: var(--text-secondary); text-decoration: none; }
        .wm-brand-nav a:hover { color: var(--text-primary); }
      `}</style>

      <nav className="wm-brand-nav" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', rowGap: 10, gap: 24, padding: '18px max(20px, 5vw)', maxWidth: 1160, margin: '0 auto' }}>
        <a href="/#/" style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'var(--text-lg)', color: 'var(--text-primary)' }}>Windmill</a>
        <div style={{ display: 'flex', gap: 18, fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
          <a href="/roadmap">Roadmap</a>
          <a href="/journal">Journal</a>
          <a href="/gym">Gym</a>
          <a href="/pricing.html">Pricing</a>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {signedIn
            ? <a href="#/settings"><Button variant="ghost" size="sm">My account</Button></a>
            : (status === 'ghost' && <Button variant="ghost" size="sm" onClick={() => setSignInOpen(true)}>Sign in</Button>)}
          <a href="/journal"><Button variant="primary" size="sm">Start</Button></a>
        </div>
      </nav>

      <header style={{ maxWidth: 720, margin: '0 auto', padding: '18vh 20px 8vh', textAlign: 'center' }}>
        <p style={{ margin: '0 0 18px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-brand)' }}>Windmill</p>
        <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 'clamp(2.4rem, 6vw, 3.6rem)', lineHeight: 1.05, letterSpacing: '-0.02em' }}>Grow, gently.</h1>
        <p style={{ margin: '22px auto 0', maxWidth: 560, fontFamily: 'var(--font-body)', fontSize: 'var(--text-lg)', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
          Three quiet tools for looking after yourself — a roadmap for what you’re learning, a journal for
          what you’re noticing, a log for how you’re training. One account. One subscription.
        </p>
      </header>

      <main style={{ maxWidth: 1080, margin: '0 auto', padding: '0 max(20px, 5vw) 12vh', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 22 }}>
        {PRODUCTS.map((product) => <ProductCard key={product.id} product={product} />)}
      </main>

      <footer style={{ borderTop: '1px solid var(--border-subtle)', padding: '28px max(20px, 5vw)', maxWidth: 1160, margin: '0 auto', display: 'flex', flexWrap: 'wrap', gap: 20, fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
        <span>© Windmill</span>
        <a href="/pricing.html" style={{ color: 'var(--text-tertiary)' }}>Pricing</a>
        <a href="/privacy.html" style={{ color: 'var(--text-tertiary)' }}>Privacy</a>
        <a href="/terms.html" style={{ color: 'var(--text-tertiary)' }}>Terms</a>
        <a href="#/connect" style={{ color: 'var(--text-tertiary)' }}>Connect your tools</a>
      </footer>

      <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} onSend={requestMagicLink} />
    </div>
  );
}

export default BrandLanding;
