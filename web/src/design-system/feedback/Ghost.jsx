// The wait, drawn. A room that has not arrived yet shows its own ground first and nothing else;
// only once the wait is long enough to be felt does a faint arrangement of bars stand in for what
// is coming. Product-neutral on purpose: this file knows about bars, blocks and a beat, and never
// about a day marker or a routine card — those compositions live with the components they mimic.
//
// GROUND FIRST, GHOST LATE. A load that finishes inside the beat draws no ghost at all: a skeleton
// that appears instantly is a flash you added, not a wait you softened. And the ghost never reaches
// full strength — it is an apology for a delay, not content, and content is what arrives next.
//
// No shimmer and no pulse anywhere in here: an animation that never ends is the one thing the calm
// ceiling forbids, and a loading state is exactly where that rule gets broken by habit.

import React from 'react';

export const GHOST_DELAY_MS = 120;
export const GHOST_FADE_MS = 150;
export const GHOST_OPACITY = 0.5;

// Pure, so the rule that matters — nothing on screen before the beat — can be asserted without a
// DOM. Reduced motion keeps the beat and drops the fade: the wait is information, the fade is not.
export function ghostVeil({ shown, reducedMotion }) {
  const opacity = shown ? GHOST_OPACITY : 0;
  if (reducedMotion) return { opacity, transition: 'none' };
  return { opacity, transition: `opacity ${GHOST_FADE_MS}ms var(--ease-soft)` };
}

// The ground is the outer layer and never fades — it is the same colour the boot script painted on
// <html> before React existed, so the whole wait is one unbroken surface. Only the marks inside it
// wait out the beat. `anchor` decides which edge the marks hold, because a room that opens on its
// newest end (the journal canvas) must be stood in for from that end.
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

// One mark: a bar of text, a block, the fill of a card. Every ghost in the app is made of these and
// of nothing else, so a room's stand-in can only ever be as detailed as the room's real geometry.
export function GhostBar({ width = '100%', height = 10, tone = 'var(--neutral-100)', radius = 'var(--radius-sm)', style = null }) {
  return <div style={{ width, height, borderRadius: radius, background: tone, flex: 'none', ...style }} />;
}
