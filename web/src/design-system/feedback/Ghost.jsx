// The wait, drawn: a room shows its own ground first, and only once the wait is long enough to be
// felt do faint bars stand in for what is coming. Product-neutral — this file knows about bars,
// blocks and a beat, never about a product's own composition.
//
// Ground first, ghost late: a load that finishes inside the beat draws no ghost at all, and the
// ghost never reaches full strength. No shimmer and no pulse: nothing here animates forever.

import React from 'react';

export const GHOST_DELAY_MS = 120;
export const GHOST_FADE_MS = 150;
export const GHOST_OPACITY = 0.5;

// Pure, so the rule that matters — nothing on screen before the beat — can be asserted without a
// DOM. Reduced motion keeps the beat and drops the fade.
export function ghostVeil({ shown, reducedMotion }) {
  const opacity = shown ? GHOST_OPACITY : 0;
  if (reducedMotion) return { opacity, transition: 'none' };
  return { opacity, transition: `opacity ${GHOST_FADE_MS}ms var(--ease-soft)` };
}

// The ground is the outer layer and never fades — the same colour the boot script painted on
// <html> — so only the marks inside it wait out the beat. `anchor` decides which edge the marks
// hold, for a room that opens on its newest end.
export function Ghost({ children, anchor = 'top' }) {
  const [shown, setShown] = React.useState(false);
  React.useEffect(() => {
    const beat = setTimeout(() => setShown(true), GHOST_DELAY_MS);
    return () => clearTimeout(beat);
  }, []);
  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const veil = ghostVeil({ shown, reducedMotion });
  return (
    <div
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: 'var(--surface-canvas)' }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: anchor === 'bottom' ? 'flex-end' : 'flex-start',
          ...veil,
        }}
      >
        {children}
      </div>
    </div>
  );
}

// One mark: a bar of text, a block, the fill of a card. Every ghost in the app is made of these.
export function GhostBar({ width = '100%', height = 10, tone = 'var(--neutral-100)', radius = 'var(--radius-sm)', style = null }) {
  return <div style={{ width, height, borderRadius: radius, background: tone, flex: 'none', ...style }} />;
}
