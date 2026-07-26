// The plain "coming soon" surface the notes/gym scaffolds share — a centered card on the
// canvas, a wordmark, a title and a line, and whatever the product hands in (the switcher).
// Product-neutral: it names no product, it just frames one.

import React from 'react';

export function ComingSoon({ title, blurb, children }) {
  return (
    <div style={stage}>
      <div style={card}>
        <span style={mark}>Windmill</span>
        <h1 style={heading}>{title}</h1>
        <p style={sub}>{blurb}</p>
        {children}
      </div>
    </div>
  );
}

export default ComingSoon;

const stage = {
  position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 'var(--space-6)', background: 'var(--surface-canvas)', fontFamily: 'var(--font-body)', color: 'var(--text-primary)',
};
const card = {
  maxWidth: '100%', width: 420, boxSizing: 'border-box', textAlign: 'center',
  background: 'var(--surface-card)', border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-lg)', padding: '28px 26px 22px',
};
const mark = { fontFamily: 'var(--font-display)', fontSize: '13px', fontWeight: 800, color: 'var(--text-tertiary)', letterSpacing: 'var(--tracking-wide)' };
const heading = { fontFamily: 'var(--font-display)', fontSize: 'var(--text-3xl)', fontWeight: 'var(--font-weight-extrabold)', letterSpacing: 'var(--tracking-tight)', margin: '10px 0 6px' };
const sub = { fontSize: 'var(--text-base)', lineHeight: 'var(--leading-base)', color: 'var(--text-secondary)', margin: '0 0 18px' };
