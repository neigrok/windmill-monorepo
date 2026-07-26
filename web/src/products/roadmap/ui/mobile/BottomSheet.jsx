// The phone node-detail sheet (X5 §S2). A bottom-edge sheet that opens at a peek
// (216px default) and lifts to at most a fraction of the viewport (62vh default) — the
// canvas is never fully covered, and there is only ever one. The taller editor sheet
// (M1) passes its own peekHeight/maxVh. The grabber is the whole gesture surface: a tap
// toggles peek↔expanded, a drag follows the finger, and a drag well past the peek
// dismisses. The parent tapping the canvas dismisses too (it flips `open`). `children`
// is the detail content the parent supplies — we own only the shell + gestures.
//
// The keyboard contract (X8 L5.5): a rename input inside the sheet raises the on-screen
// keyboard; the sheet rises above it, never under it. We measure the inset the same way the
// list does (innerHeight − visualViewport.height), force the sheet fully expanded so its top
// header clears the keyboard, and pad the scroller so its lower content can reach above it.

import React, { useEffect, useRef, useState } from 'react';

const PEEK_HEIGHT = 216;
const MAX_VH = 62;
const DISMISS_THRESHOLD = 90; // px dragged past the peek before we let go into a dismiss
const TAP_SLOP = 4;           // movement under this reads as a tap, not a drag

const sheetHeightPx = (maxVh) => Math.round((window.innerHeight * maxVh) / 100);
const peekOffsetPx = (maxVh, peekHeight) => Math.max(0, sheetHeightPx(maxVh) - peekHeight);
const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function BottomSheet({ open, onDismiss, children, peekHeight = PEEK_HEIGHT, maxVh = MAX_VH }) {
  const [rendered, setRendered] = useState(false);
  const [shown, setShown] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dragOffset, setDragOffset] = useState(null); // px while dragging, else null
  const [kbInset, setKbInset] = useState(0); // px of viewport the on-screen keyboard eats

  const wasOpen = useRef(false);
  const dragging = useRef(false);
  const startY = useRef(0);
  const baseOffset = useRef(0);
  const moved = useRef(false);

  const reduced = prefersReducedMotion();

  // Track the keyboard inset while the sheet is open (visualViewport shrinks as the keyboard
  // opens; innerHeight stays the layout height). Drops back to 0 the moment the sheet closes.
  useEffect(() => {
    if (!open) { setKbInset(0); return undefined; }
    const vv = typeof window !== 'undefined' ? window.visualViewport : undefined;
    if (!vv) return undefined;
    const measure = () => setKbInset(Math.max(0, window.innerHeight - vv.height));
    measure();
    vv.addEventListener('resize', measure);
    return () => { vv.removeEventListener('resize', measure); setKbInset(0); };
  }, [open]);

  useEffect(() => {
    if (open && !wasOpen.current) {
      wasOpen.current = true;
      setExpanded(false);
      setRendered(true);
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    if (!open && wasOpen.current) {
      wasOpen.current = false;
      setShown(false);
      const timer = setTimeout(() => {
        setRendered(false);
        setDragOffset(null);
      }, reduced ? 0 : 280);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [open, reduced]);

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragging.current = true;
    moved.current = false;
    startY.current = e.clientY;
    baseOffset.current = expanded ? 0 : peekOffsetPx(maxVh, peekHeight);
    setDragOffset(baseOffset.current);
  };

  const onPointerMove = (e) => {
    if (!dragging.current) return;
    const delta = e.clientY - startY.current;
    if (Math.abs(delta) > TAP_SLOP) moved.current = true;
    const next = Math.min(Math.max(baseOffset.current + delta, 0), sheetHeightPx(maxVh));
    setDragOffset(next);
  };

  const onPointerUp = (e) => {
    if (!dragging.current) return;
    dragging.current = false;
    const settled = baseOffset.current + (e.clientY - startY.current);
    setDragOffset(null);
    if (!moved.current) {
      setExpanded((x) => !x);
      return;
    }
    const peek = peekOffsetPx(maxVh, peekHeight);
    if (settled > peek + DISMISS_THRESHOLD) {
      onDismiss?.();
      return;
    }
    setExpanded(settled < peek / 2);
  };

  if (!rendered) return null;

  // max(0px, …) so a peek taller than the sheet (a tall editor peek on an ultra-short
  // landscape viewport) can't push resting negative and float the sheet off the bottom edge.
  // A raised keyboard forces the sheet fully expanded so its header rides clear of the keyboard
  // (and freezes the drag — you can't pull the sheet down while typing into it).
  const lifted = kbInset > 0;
  const followingFinger = dragOffset != null && !lifted;
  const resting = expanded || lifted ? 'translateY(0)' : `translateY(max(0px, calc(${maxVh}vh - ${peekHeight}px)))`;
  let transform;
  if (followingFinger) transform = `translateY(${dragOffset}px)`;
  else if (shown) transform = resting;
  else transform = reduced ? resting : 'translateY(100%)';

  const transition =
    followingFinger
      ? 'none'
      : reduced
        ? 'opacity var(--duration-base) var(--ease-soft)'
        : 'transform var(--duration-base) var(--ease-soft), opacity var(--duration-base) var(--ease-soft)';

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: `${maxVh}vh`,
        maxHeight: `${maxVh}vh`,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface-card)',
        borderTopLeftRadius: 'var(--radius-xl)',
        borderTopRightRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-lg)',
        zIndex: 40,
        transform,
        opacity: shown ? 1 : 0,
        transition,
        willChange: 'transform',
      }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 44,
          cursor: 'grab',
          touchAction: 'none',
        }}
      >
        <span
          style={{
            width: 40,
            height: 5,
            borderRadius: 'var(--radius-full)',
            background: 'var(--border-default)',
          }}
        />
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          padding: `0 var(--space-4) calc(env(safe-area-inset-bottom, 0px) + var(--space-4) + ${kbInset}px)`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default BottomSheet;
